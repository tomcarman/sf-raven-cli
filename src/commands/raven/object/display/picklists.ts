import { writeFileSync } from 'node:fs';
import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import chalk from 'chalk';
import { mapWithConcurrency } from '../../../../shared/concurrency.js';
import {
  applyAvailability,
  formatAvailabilityCell,
  formatDefaultMarker,
  masterRecordTypeId,
  masterRecordTypeName,
  selectPicklistFields,
  toPicklistField,
  type DescribeFieldWithPicklist,
  type ObjectPicklists,
  type PicklistField,
  type PicklistValue,
  type RecordTypeAvailability,
  type RecordTypeColumn,
} from '../../../../shared/picklists.js';
import { escapeCsvValue, parseSObjectList } from '../../../../shared/query.js';
import { renderTable, type TableColumn } from '../../../../shared/table.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.object.display.picklists');

export type ObjectDisplayPicklistsResult = {
  objects: ObjectPicklists[];
};

export default class ObjectDisplayPicklists extends SfCommand<ObjectDisplayPicklistsResult> {
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
    csv: Flags.file({
      summary: messages.getMessage('flags.csv.summary'),
      char: 'c',
    }),
  };

  public async run(): Promise<ObjectDisplayPicklistsResult> {
    const { flags } = await this.parse(ObjectDisplayPicklists);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    const connection = flags['target-org'].getConnection();
    const sobjects = parseSObjectList(flags.sobject);

    this.spinner.start(messages.getMessage('info.loading'));

    let objects: ObjectPicklists[];

    try {
      objects = await Promise.all(sobjects.map((sobject) => describePicklists(connection, sobject, flags.field)));
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

/** How many UI API record-type reads to keep in flight at once. */
const recordTypeConcurrency = 5;

const describePicklists = async (
  connection: Connection,
  sobject: string,
  only: string | undefined
): Promise<ObjectPicklists> => {
  const described = await describeFields(connection, sobject);
  const fields = selectPicklistFields(described, sobject, only).map(toPicklistField);
  const recordTypes = await listRecordTypes(connection, sobject);

  // Master alone means the object does not use record types, so there is no
  // matrix worth drawing - the flat list says everything.
  if (recordTypes.length === 0) {
    return { sobject, fields };
  }

  const columns = [{ id: masterRecordTypeId, developerName: masterRecordTypeName, name: masterRecordTypeName, accessible: true }, ...recordTypes];
  const availability = await fetchAvailability(connection, sobject, columns);

  return {
    sobject,
    recordTypes: columns.map((column) => ({
      ...column,
      accessible: availability.get(column.developerName) != null,
    })),
    fields: applyAvailability(fields, columns, availability),
  };
};

type RecordTypeRecord = { Id: string; DeveloperName: string; Name: string };

const listRecordTypes = async (connection: Connection, sobject: string): Promise<RecordTypeColumn[]> => {
  const result = await connection.query<RecordTypeRecord>(
    `SELECT Id, DeveloperName, Name FROM RecordType WHERE SObjectType = '${sobject}' AND IsActive = true ORDER BY DeveloperName`
  );

  return result.records.map((record) => ({
    id: record.Id,
    developerName: record.DeveloperName,
    name: record.Name,
    accessible: true,
  }));
};

type PicklistValuesResponse = {
  picklistFieldValues?: Record<string, { values?: Array<{ value: string }>; defaultValue?: { value: string } | null }>;
};

const fetchAvailability = async (
  connection: Connection,
  sobject: string,
  recordTypes: readonly RecordTypeColumn[]
): Promise<Map<string, RecordTypeAvailability>> => {
  const entries = await mapWithConcurrency(recordTypes, recordTypeConcurrency, async (recordType) => {
    const response = await fetchPicklistValues(connection, sobject, recordType.id);

    return [recordType.developerName, response] as const;
  });

  return new Map(entries);
};

/** A record type the running user cannot see returns an error, not a 404. */
const fetchPicklistValues = async (
  connection: Connection,
  sobject: string,
  recordTypeId: string
): Promise<RecordTypeAvailability> => {
  try {
    const response = await connection.request<PicklistValuesResponse>({
      method: 'GET',
      url: `/services/data/v${connection.getApiVersion()}/ui-api/object-info/${sobject}/picklist-values/${recordTypeId}`,
    });

    return new Map(
      Object.entries(response.picklistFieldValues ?? {}).map(([fieldName, field]) => [
        fieldName,
        {
          values: new Set((field.values ?? []).map((value) => value.value)),
          ...(field.defaultValue == null ? {} : { defaultValue: field.defaultValue.value }),
        },
      ])
    );
  } catch {
    return undefined;
  }
};

const describeFields = async (connection: Connection, sobject: string): Promise<DescribeFieldWithPicklist[]> => {
  try {
    const described = await connection.describe(sobject);

    return described.fields as unknown as DescribeFieldWithPicklist[];
  } catch {
    throw messages.createError('error.unknownSObject', [sobject]);
  }
};

const printObject = (ux: Ux, object: ObjectPicklists): void => {
  ux.log(`\n${chalk.bold(object.sobject)} ${chalk.dim(`(${object.fields.length} picklist fields)`)}`);

  if (object.fields.length === 0) {
    ux.log(`\n${messages.getMessage('info.noPicklists')}`);
    return;
  }

  for (const field of object.fields) {
    printField(ux, field, object.recordTypes);
  }
};

const printField = (ux: Ux, field: PicklistField, recordTypes: readonly RecordTypeColumn[] | undefined): void => {
  const notes = [
    ...(field.multiSelect ? [messages.getMessage('label.multiSelect')] : []),
    ...(field.controllerName == null ? [] : [messages.getMessage('label.controlledBy', [field.controllerName])]),
  ];

  const suffix = notes.length === 0 ? '' : `  ${chalk.dim(notes.join('  '))}`;

  ux.log(`\n${chalk.cyan(field.label)} ${chalk.dim(`(${field.name})`)}${suffix}\n`);

  if (field.values.length === 0) {
    ux.log(messages.getMessage('info.noValues'));
    return;
  }

  for (const line of renderTable(field.values, valueColumns(recordTypes))) {
    ux.log(line);
  }
};

const valueColumns = (recordTypes: readonly RecordTypeColumn[] | undefined): Array<TableColumn<PicklistValue>> => [
  { header: 'Default', get: (value) => formatDefaultMarker(value.isDefault) },
  { header: 'Value', get: (value) => value.label },
  { header: 'API Name', get: (value) => value.value },
  ...(recordTypes ?? []).map((recordType) => ({
    header: recordType.accessible
      ? recordType.developerName
      : `${recordType.developerName} ${messages.getMessage('label.unavailable')}`,
    get: (value: PicklistValue): string => formatAvailabilityCell(value, recordType),
  })),
];

const countRows = (objects: readonly ObjectPicklists[]): number =>
  objects.reduce((total, object) => total + object.fields.reduce((sum, field) => sum + field.values.length, 0), 0);

const writeCsv = (filePath: string, objects: readonly ObjectPicklists[], includeObjectColumn: boolean): void => {
  // Objects can differ in their record types, so the header is the union of all
  // of them and a value simply reads false under a record type its object lacks.
  const recordTypeNames = [
    ...new Set(objects.flatMap((object) => (object.recordTypes ?? []).map((recordType) => recordType.developerName))),
  ];

  const columns = [
    ...(includeObjectColumn ? ['Object'] : []),
    'Field',
    'Field API Name',
    'Value',
    'Value API Name',
    'Default',
    ...recordTypeNames,
  ];

  const rows = [
    columns.map(escapeCsvValue).join(','),
    ...objects.flatMap((object) =>
      object.fields.flatMap((field) =>
        field.values.map((value) =>
          [
            ...(includeObjectColumn ? [object.sobject] : []),
            field.label,
            field.name,
            value.label,
            value.value,
            value.isDefault,
            ...recordTypeNames.map((name) => value.availability?.[name] === true),
          ]
            .map(escapeCsvValue)
            .join(',')
        )
      )
    ),
  ];

  writeFileSync(filePath, `${rows.join('\n')}\n`, 'utf8');
};
