import { writeFileSync } from 'node:fs';
import { SfCommand, Flags, Ux } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { escapeCsvValue, parseSObjectList } from '../../../../shared/query.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.object.display.fields');

export type ObjectDisplayFieldsResult = {
  result: object;
};

export default class ObjectDisplayFields extends SfCommand<ObjectDisplayFieldsResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: true,
    }),
    sobject: Flags.string({
      summary: messages.getMessage('flags.sobject.summary'),
      char: 's',
      required: true,
    }),
    csv: Flags.file({
      summary: messages.getMessage('flags.csv.summary'),
      char: 'c',
    }),
    required: Flags.boolean({
      summary: messages.getMessage('flags.required.summary'),
      char: 'r',
      default: false,
    }),
    type: Flags.string({
      summary: messages.getMessage('flags.type.summary'),
      char: 't',
      multiple: true,
    }),
  };

  public async run(): Promise<ObjectDisplayFieldsResult> {
    type QueryResult = {
      totalSize: number;
      done: boolean;
      records: Record[];
    };

    type Record = {
      [key: string]: string | boolean | null | object;
      attributes: object;
      EntityDefinition: {
        QualifiedApiName: string;
      };
      Label: string;
      QualifiedApiName: string;
      DataType: string;
      IsNillable: boolean;
      Description: string | null;
    };

    const { flags } = await this.parse(ObjectDisplayFields);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    const org = flags['target-org'];
    const conn = org.getConnection();
    const sobjects = parseSObjectList(flags.sobject);
    let records: Record[] = [];

    this.spinner.start('Loading...');

    try {
      await sobjects.reduce(async (previousQuery, sobject) => {
        await previousQuery;

        const query = `SELECT EntityDefinition.QualifiedApiName, Label, QualifiedApiName, DataType, IsNillable, Description FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${sobject}' ORDER BY QualifiedApiName`;
        const queryResult = (await conn.query(query)) as QueryResult;
        records.push(...queryResult.records);
      }, Promise.resolve());
    } finally {
      this.spinner.stop();
    }

    if (flags.required) {
      records = records.filter((record) => !record.IsNillable);
    }

    if (flags.type != null && flags.type.length > 0) {
      const typeFilters = flags.type.map((t) => t.toLowerCase());
      records = records.filter((record) =>
        typeFilters.some((typeFilter) => record.DataType.toLowerCase().includes(typeFilter))
      );
    }

    const result: QueryResult = {
      totalSize: records.length,
      done: true,
      records,
    };
    const includeObjectColumn = sobjects.length > 1;

    if (flags.csv) {
      writeCsv(flags.csv, result.records, includeObjectColumn);
      ux.log(messages.getMessage('info.csvWritten', [result.records.length.toString(), flags.csv]));
    } else {
      ux.table(result.records, getTableColumns(includeObjectColumn));
    }

    // Return url
    if (sobjects.length === 1) {
      ux.log(`\n${conn.instanceUrl}/lightning/setup/ObjectManager/${sobjects[0]}/FieldsAndRelationships/view`);
    }

    // Return an object to be displayed with --json
    return result as unknown as ObjectDisplayFieldsResult;
  }
}

type FieldRecord = {
  EntityDefinition: { QualifiedApiName: string };
  Label: string;
  QualifiedApiName: string;
  DataType: string;
  IsNillable: boolean;
  Description: string | null;
};

const getTableColumns = (
  includeObjectColumn: boolean
): {
  [key: string]: {
    header: string;
    get: (row: FieldRecord) => string;
  };
} => ({
  ...(includeObjectColumn
    ? {
        object: {
          header: 'Object',
          get: (row) => row.EntityDefinition.QualifiedApiName,
        },
      }
    : {}),
  label: {
    header: 'Name',
    get: (row) => row.Label,
  },
  qualifiedApiName: {
    header: 'Developer Name',
    get: (row) => row.QualifiedApiName,
  },
  dataType: {
    header: 'Type',
    get: (row) => row.DataType,
  },
  isRequired: {
    header: 'Required',
    get: (row) => (!row.IsNillable ? '✓' : ''),
  },
  description: {
    header: 'Description',
    get: (row) => truncate(row.Description, 60),
  },
});

const writeCsv = (filePath: string, records: FieldRecord[], includeObjectColumn: boolean): void => {
  const columns = includeObjectColumn
    ? ['Object', 'Name', 'Developer Name', 'Type', 'Required', 'Description']
    : ['Name', 'Developer Name', 'Type', 'Required', 'Description'];
  const rows = [
    columns.map(escapeCsvValue).join(','),
    ...records.map((record) =>
      (includeObjectColumn
        ? [record.EntityDefinition.QualifiedApiName, record.Label, record.QualifiedApiName, record.DataType, record.IsNillable ? 'false' : 'true', record.Description ?? '']
        : [record.Label, record.QualifiedApiName, record.DataType, record.IsNillable ? 'false' : 'true', record.Description ?? '']
      )
        .map(escapeCsvValue)
        .join(',')
    ),
  ];

  writeFileSync(filePath, `${rows.join('\n')}\n`, 'utf8');
};

const truncate = (value: string | null, maxLength: number): string => {
  if (value == null) return '';
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
};
