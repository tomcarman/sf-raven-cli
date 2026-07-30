import { writeFileSync } from 'node:fs';
import { SfCommand, Flags, Ux } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { escapeCsvValue, parseSObjectList } from '../../../../shared/query.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.object.display.validationrules');

type ValidationRuleRecord = {
  Id: string;
  ValidationName: string;
  Active: boolean;
  Description: string | null;
  ErrorMessage: string;
  SObjectType: string;
};

type ToolingConnection = {
  tooling: {
    query: <T>(soql: string) => Promise<{ records: T[] }>;
  };
  instanceUrl: string;
};

export type ObjectDisplayValidationRulesResult = {
  totalSize: number;
  done: boolean;
  records: ValidationRuleRecord[];
};

export default class ObjectDisplayValidationRules extends SfCommand<ObjectDisplayValidationRulesResult> {
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
    active: Flags.boolean({
      summary: messages.getMessage('flags.active.summary'),
      char: 'a',
      default: false,
    }),
  };

  public async run(): Promise<ObjectDisplayValidationRulesResult> {
    const { flags } = await this.parse(ObjectDisplayValidationRules);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    const org = flags['target-org'];
    const conn = org.getConnection() as unknown as ToolingConnection;
    const sobjects = parseSObjectList(flags.sobject);
    const records: ValidationRuleRecord[] = [];

    this.spinner.start('Loading...');

    try {
      await sobjects.reduce(async (previousQuery, sobject) => {
        await previousQuery;

        const query = `SELECT Id, ValidationName, Active, Description, ErrorMessage FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${sobject}' ORDER BY ValidationName`;
        const queryResult = await conn.tooling.query<ValidationRuleRecord>(query);
        records.push(...queryResult.records.map((record) => ({ ...record, SObjectType: sobject })));
      }, Promise.resolve());
    } finally {
      this.spinner.stop();
    }

    const filteredRecords = flags.active ? records.filter((record) => record.Active) : records;
    const includeObjectColumn = sobjects.length > 1;

    if (flags.csv) {
      writeCsv(flags.csv, filteredRecords, includeObjectColumn);
      ux.log(messages.getMessage('info.csvWritten', [filteredRecords.length.toString(), flags.csv]));
    } else {
      ux.table(filteredRecords, getTableColumns(includeObjectColumn));
    }

    if (sobjects.length === 1) {
      ux.log(`\n${conn.instanceUrl}/lightning/setup/ObjectManager/${sobjects[0]}/ValidationRules/view`);
    }

    return { totalSize: filteredRecords.length, done: true, records: filteredRecords };
  }
}

const getTableColumns = (
  includeObjectColumn: boolean
): {
  [key: string]: {
    header: string;
    get: (row: ValidationRuleRecord) => string;
  };
} => ({
  ...(includeObjectColumn
    ? {
        object: {
          header: 'Object',
          get: (row) => row.SObjectType,
        },
      }
    : {}),
  validationName: {
    header: 'Name',
    get: (row) => row.ValidationName,
  },
  active: {
    header: 'Active',
    get: (row) => (row.Active ? '✓' : '✗'),
  },
  description: {
    header: 'Description',
    get: (row) => truncate(row.Description, 50),
  },
  errorMessage: {
    header: 'Error Message',
    get: (row) => truncate(row.ErrorMessage, 60),
  },
});

const writeCsv = (filePath: string, records: ValidationRuleRecord[], includeObjectColumn: boolean): void => {
  const columns = includeObjectColumn
    ? ['Object', 'Name', 'Active', 'Description', 'Error Message']
    : ['Name', 'Active', 'Description', 'Error Message'];
  const rows = [
    columns.map(escapeCsvValue).join(','),
    ...records.map((record) =>
      (includeObjectColumn
        ? [
            record.SObjectType,
            record.ValidationName,
            record.Active ? 'true' : 'false',
            record.Description ?? '',
            record.ErrorMessage,
          ]
        : [record.ValidationName, record.Active ? 'true' : 'false', record.Description ?? '', record.ErrorMessage]
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
