import { writeFileSync } from 'node:fs';
import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import chalk from 'chalk';
import {
  buildDeepCountQuery,
  buildFieldUsage,
  buildSampleQuery,
  countPopulated,
  formatPercent,
  formatUsageMethod,
  isDeepCountable,
  mapWithConcurrency,
  selectFields,
  sortFieldUsage,
  toPercent,
  usageBar,
  type DescribeField,
  type FieldUsage,
  type ObjectFieldUsage,
} from '../../../../shared/fieldUsage.js';
import { escapeCsvValue } from '../../../../shared/query.js';
import { buildFieldChunks } from '../../../../shared/recordQuery.js';
import { renderTable, type TableColumn } from '../../../../shared/table.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.object.display.fieldusage');

export type ObjectDisplayFieldusageResult = {
  objects: ObjectFieldUsage[];
};

export default class ObjectDisplayFieldusage extends SfCommand<ObjectDisplayFieldusageResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
    }),
    sobject: Flags.string({
      summary: messages.getMessage('flags.sobject.summary'),
      char: 's',
      required: true,
    }),
    field: Flags.string({
      summary: messages.getMessage('flags.field.summary'),
    }),
    'custom-only': Flags.boolean({
      summary: messages.getMessage('flags.custom-only.summary'),
      default: false,
    }),
    'sample-size': Flags.integer({
      summary: messages.getMessage('flags.sample-size.summary'),
      min: 1,
      default: 1000,
    }),
    deep: Flags.boolean({
      summary: messages.getMessage('flags.deep.summary'),
      default: false,
    }),
    csv: Flags.file({
      summary: messages.getMessage('flags.csv.summary'),
      char: 'c',
    }),
  };

  public async run(): Promise<ObjectDisplayFieldusageResult> {
    const { flags } = await this.parse(ObjectDisplayFieldusage);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    const connection = flags['target-org'].getConnection();
    const sobjects = parseSobjects(flags.sobject);
    const objects: ObjectFieldUsage[] = [];

    this.spinner.start(messages.getMessage(flags.deep ? 'info.counting' : 'info.sampling'));

    try {
      for (const sobject of sobjects) {
        // Sequential: each object needs several round-trips and orgs rate-limit.
        // eslint-disable-next-line no-await-in-loop
        objects.push(await sampleObject(connection, sobject, flags));
      }
    } finally {
      this.spinner.stop();
    }

    if (flags.csv) {
      writeCsv(flags.csv, objects, sobjects.length > 1);
      ux.log(messages.getMessage('info.csvWritten', [countRows(objects).toString(), flags.csv]));
    } else {
      for (const object of objects) {
        printObject(ux, object);
      }
    }

    if (sobjects.length === 1) {
      ux.log(`\n${connection.instanceUrl}/lightning/setup/ObjectManager/${sobjects[0]}/FieldsAndRelationships/view`);
    }

    return { objects };
  }
}

type SampleFlags = {
  field?: string;
  'custom-only': boolean;
  'sample-size': number;
  deep: boolean;
};

/** How many COUNT() queries --deep keeps in flight at once. */
const deepConcurrency = 5;

export const sampleObject = async (
  connection: Connection,
  sobject: string,
  flags: SampleFlags
): Promise<ObjectFieldUsage> => {
  const describe = await describeObject(connection, sobject);
  const fields = selectFields(describe.fields, sobject, {
    only: flags.field,
    customOnly: flags['custom-only'],
  });

  if (fields.length === 0) {
    throw messages.createError('error.noFields', [sobject]);
  }

  const sampleSize = flags['sample-size'];
  const hasCreatedDate = describe.fields.some((field) => field.name === 'CreatedDate');
  const [totalRecords, records] = await Promise.all([
    countRecords(connection, sobject),
    fetchSample(connection, sobject, fields, sampleSize, hasCreatedDate),
  ]);

  const counts = countPopulated(records, fields.map((field) => field.name));
  const sampled = buildFieldUsage(fields, counts, records.length, 'sampled');

  if (!flags.deep) {
    return {
      sobject,
      method: 'sampled',
      sampleSize: records.length,
      totalRecords,
      fields: sortFieldUsage(sampled),
    };
  }

  return {
    sobject,
    method: 'deep',
    sampleSize: records.length,
    totalRecords,
    fields: sortFieldUsage(await deepenUsage(connection, sobject, fields, sampled, totalRecords)),
  };
};

/**
 * Replaces each sampled figure with a true org-wide count where the field can
 * be filtered on. Fields that cannot be (long text, encrypted, and friends)
 * keep their sampled number and stay marked as such.
 */
const deepenUsage = async (
  connection: Connection,
  sobject: string,
  fields: readonly DescribeField[],
  sampled: readonly FieldUsage[],
  totalRecords: number
): Promise<FieldUsage[]> => {
  const countable = fields.filter(isDeepCountable);
  const counts = await mapWithConcurrency(countable, deepConcurrency, async (field) => {
    const result = await connection.query(buildDeepCountQuery(sobject, field.name));

    return [field.name, result.totalSize] as const;
  });

  const deepCounts = new Map(counts);

  return sampled.map((usage) => {
    const populated = deepCounts.get(usage.name);

    return populated == null
      ? usage
      : { ...usage, populated, total: totalRecords, percent: toPercent(populated, totalRecords), method: 'deep' as const };
  });
};

const describeObject = async (connection: Connection, sobject: string): Promise<{ fields: DescribeField[] }> => {
  try {
    const described = await connection.describe(sobject);

    return { fields: described.fields as unknown as DescribeField[] };
  } catch {
    throw messages.createError('error.unknownSObject', [sobject]);
  }
};

/** COUNT() returns its answer in totalSize rather than as a record. */
const countRecords = async (connection: Connection, sobject: string): Promise<number> => {
  const result = await connection.query(`SELECT COUNT() FROM ${sobject}`);

  return result.totalSize;
};

/**
 * The field list can outgrow the URL limit, so the sample is fetched in chunks
 * and merged by Id. Every chunk shares one deterministic ordering, so they all
 * see the same records.
 */
const fetchSample = async (
  connection: Connection,
  sobject: string,
  fields: readonly DescribeField[],
  sampleSize: number,
  hasCreatedDate: boolean
): Promise<Array<Record<string, unknown>>> => {
  const fieldNames = ['Id', ...fields.map((field) => field.name).filter((name) => name !== 'Id')];
  const buildSoql = (chunkFields: string[]): string =>
    buildSampleQuery(sobject, chunkFields, sampleSize, hasCreatedDate);

  const chunks = buildFieldChunks(fieldNames, buildSoql);
  const results = await Promise.all(chunks.map((chunkFields) => connection.query(buildSoql(chunkFields))));

  const merged = new Map<string, Record<string, unknown>>();

  for (const result of results) {
    for (const record of result.records) {
      const id = String(record.Id);
      merged.set(id, { ...merged.get(id), ...record });
    }
  }

  return [...merged.values()];
};

const parseSobjects = (sobjectFlag: string): string[] => {
  const sobjects = sobjectFlag
    .split(',')
    .map((sobject) => sobject.trim())
    .filter((sobject) => sobject.length > 0);

  return Array.from(new Set(sobjects));
};

const printObject = (ux: Ux, object: ObjectFieldUsage): void => {
  const scope =
    object.method === 'deep'
      ? messages.getMessage('label.deepScope', [object.totalRecords.toLocaleString()])
      : messages.getMessage('label.sampledScope', [
          (object.sampleSize ?? 0).toLocaleString(),
          object.totalRecords.toLocaleString(),
        ]);

  ux.log(`\n${chalk.bold(object.sobject)} ${chalk.dim(scope)}\n`);

  for (const line of renderTable(object.fields, usageColumns(object.method))) {
    ux.log(line);
  }
};

const usageColumns = (objectMethod: ObjectFieldUsage['method']): Array<TableColumn<FieldUsage>> => [
  { header: 'Field', get: (field) => field.label },
  { header: 'API Name', get: (field) => field.name },
  { header: 'Type', get: (field) => field.type },
  { header: 'Populated', get: (field) => field.populated.toLocaleString() },
  { header: '%', get: (field) => `${formatPercent(field.percent)}${formatUsageMethod(field, objectMethod)}` },
  { header: 'Usage', get: (field) => usageBar(field.percent) },
];

const countRows = (objects: readonly ObjectFieldUsage[]): number =>
  objects.reduce((total, object) => total + object.fields.length, 0);

const writeCsv = (filePath: string, objects: readonly ObjectFieldUsage[], includeObjectColumn: boolean): void => {
  const columns = [
    ...(includeObjectColumn ? ['Object'] : []),
    'Field',
    'API Name',
    'Type',
    'Populated',
    'Total',
    'Percent',
    'Method',
  ];

  const rows = [
    columns.map(escapeCsvValue).join(','),
    ...objects.flatMap((object) =>
      object.fields.map((field) =>
        [
          ...(includeObjectColumn ? [object.sobject] : []),
          field.label,
          field.name,
          field.type,
          field.populated,
          field.total,
          field.percent,
          field.method,
        ]
          .map(escapeCsvValue)
          .join(',')
      )
    ),
  ];

  writeFileSync(filePath, `${rows.join('\n')}\n`, 'utf8');
};
