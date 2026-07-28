import { writeFileSync } from 'node:fs';
import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import chalk from 'chalk';
import {
  formatDefaultMarker,
  selectPicklistFields,
  toPicklistField,
  type DescribeFieldWithPicklist,
  type ObjectPicklists,
  type PicklistField,
  type PicklistValue,
} from '../../../../shared/picklists.js';
import { escapeCsvValue } from '../../../../shared/query.js';
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
    const sobjects = parseSobjects(flags.sobject);

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

const describePicklists = async (
  connection: Connection,
  sobject: string,
  only: string | undefined
): Promise<ObjectPicklists> => {
  const fields = await describeFields(connection, sobject);

  return { sobject, fields: selectPicklistFields(fields, sobject, only).map(toPicklistField) };
};

const describeFields = async (connection: Connection, sobject: string): Promise<DescribeFieldWithPicklist[]> => {
  try {
    const described = await connection.describe(sobject);

    return described.fields as unknown as DescribeFieldWithPicklist[];
  } catch {
    throw messages.createError('error.unknownSObject', [sobject]);
  }
};

const parseSobjects = (sobjectFlag: string): string[] => {
  const sobjects = sobjectFlag
    .split(',')
    .map((sobject) => sobject.trim())
    .filter((sobject) => sobject.length > 0);

  return Array.from(new Set(sobjects));
};

const printObject = (ux: Ux, object: ObjectPicklists): void => {
  ux.log(`\n${chalk.bold(object.sobject)} ${chalk.dim(`(${object.fields.length} picklist fields)`)}`);

  if (object.fields.length === 0) {
    ux.log(`\n${messages.getMessage('info.noPicklists')}`);
    return;
  }

  for (const field of object.fields) {
    printField(ux, field);
  }
};

const printField = (ux: Ux, field: PicklistField): void => {
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

  for (const line of renderTable(field.values, valueColumns)) {
    ux.log(line);
  }
};

const valueColumns: Array<TableColumn<PicklistValue>> = [
  { header: 'Default', get: (value) => formatDefaultMarker(value.isDefault) },
  { header: 'Value', get: (value) => value.label },
  { header: 'API Name', get: (value) => value.value },
];

const countRows = (objects: readonly ObjectPicklists[]): number =>
  objects.reduce((total, object) => total + object.fields.reduce((sum, field) => sum + field.values.length, 0), 0);

const writeCsv = (filePath: string, objects: readonly ObjectPicklists[], includeObjectColumn: boolean): void => {
  const columns = [
    ...(includeObjectColumn ? ['Object'] : []),
    'Field',
    'Field API Name',
    'Value',
    'Value API Name',
    'Default',
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
          ]
            .map(escapeCsvValue)
            .join(',')
        )
      )
    ),
  ];

  writeFileSync(filePath, `${rows.join('\n')}\n`, 'utf8');
};
