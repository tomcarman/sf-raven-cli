import { Args } from '@oclif/core';
import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import {
  buildRecentQuery,
  createdSortField,
  defaultFields,
  findNameField,
  formatSortDate,
  hasField,
  hasRecordTypes,
  mergeFields,
  modifiedSortField,
  type RecentDescribe,
} from '../../../shared/recentQuery.js';
import {
  formatRecordCell,
  formatRecordCsv,
  formatRecordJson,
  formatRecordToon,
  resolveFieldValue,
  stripAttributes,
  type RecordOutput,
} from '../../../shared/recordQuery.js';
import { renderTable, type TableColumn } from '../../../shared/table.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.query.recent');

const recordFormats = ['table', 'json', 'csv', 'toon'] as const;
type RecordFormat = (typeof recordFormats)[number];

const recordTypeField = 'RecordType.DeveloperName';

export type QueryRecentResult = {
  sobject: string;
  fields: string[];
  records: Array<Record<string, unknown>>;
};

export default class QueryRecent extends SfCommand<QueryRecentResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly args = {
    sobject: Args.string({
      description: messages.getMessage('args.sobject.description'),
      required: true,
    }),
  };

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
    }),
    limit: Flags.integer({
      summary: messages.getMessage('flags.limit.summary'),
      char: 'l',
      min: 1,
      default: 10,
    }),
    modified: Flags.boolean({
      summary: messages.getMessage('flags.modified.summary'),
      default: false,
    }),
    recordtype: Flags.string({
      summary: messages.getMessage('flags.recordtype.summary'),
    }),
    fields: Flags.string({
      summary: messages.getMessage('flags.fields.summary'),
      char: 'f',
    }),
    format: Flags.option({
      summary: messages.getMessage('flags.format.summary'),
      char: 'F',
      options: recordFormats,
      default: 'table',
    })(),
    truncate: Flags.integer({
      summary: messages.getMessage('flags.truncate.summary'),
      char: 't',
      default: 80,
      min: 0,
    }),
  };

  public async run(): Promise<QueryRecentResult> {
    const { args, flags } = await this.parse(QueryRecent);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    const connection = flags['target-org'].getConnection();
    const sobject = args.sobject;
    const describe = await describeObject(connection, sobject);

    const sortField = flags.modified ? modifiedSortField : createdSortField;

    if (!hasField(describe.fields, sortField)) {
      throw messages.createError('error.missingSortField', [sobject, sortField]);
    }

    if (flags.recordtype != null && !hasRecordTypes(describe)) {
      throw messages.createError('error.noRecordTypes', [sobject]);
    }

    const fields = mergeFields(
      [
        ...defaultFields(findNameField(describe.fields), flags.modified),
        ...(flags.recordtype == null ? [] : [recordTypeField]),
      ],
      flags.fields
    );

    ux.spinner.start(messages.getMessage('info.fetching'));

    let records: Array<Record<string, unknown>>;

    try {
      const result = await connection.query(
        buildRecentQuery({ sobject, fields, sortField, limit: flags.limit, recordType: flags.recordtype })
      );

      records = (result.records as Array<Record<string, unknown>>).map(stripAttributes);
    } finally {
      ux.spinner.stop();
    }

    const output: RecordOutput = { fields, records };

    ux.log(formatRecentOutput(output, flags.format, sortField, flags.truncate));

    return { sobject, fields, records };
  }
}

const describeObject = async (connection: Connection, sobject: string): Promise<RecentDescribe> => {
  try {
    return (await connection.describe(sobject)) as unknown as RecentDescribe;
  } catch {
    throw messages.createError('error.unknownSObject', [sobject]);
  }
};

const formatRecentOutput = (
  output: RecordOutput,
  format: RecordFormat,
  sortField: string,
  truncate: number
): string => {
  switch (format) {
    case 'json':
      return formatRecordJson(output);
    case 'csv':
      return formatRecordCsv(output);
    case 'toon':
      return formatRecordToon(output);
    default:
      return renderTable(output.records, recentColumns(output.fields, sortField, truncate)).join('\n');
  }
};

/**
 * One column per field, with the column being sorted on carrying its relative
 * age so "how recent is recent" is readable at a glance.
 */
const recentColumns = (
  fields: readonly string[],
  sortField: string,
  truncate: number
): Array<TableColumn<Record<string, unknown>>> =>
  fields.map((field) => ({
    header: field,
    get: (record): string =>
      field === sortField
        ? formatSortDate(resolveFieldValue(record, field))
        : formatRecordCell(resolveFieldValue(record, field), truncate),
  }));
