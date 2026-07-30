import { writeFileSync } from 'node:fs';
import { SfCommand, Flags, Ux } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { escapeCsvValue, parseSObjectList } from '../../../../shared/query.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.object.display.recordtypes');

export type ObjectDisplayRecordtypesResult = {
  result: object;
};

export default class ObjectDisplayRecordtypes extends SfCommand<ObjectDisplayRecordtypesResult> {
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
  };

  public async run(): Promise<ObjectDisplayRecordtypesResult> {
    type QueryResult = {
      totalSize: number;
      done: boolean;
      records: Record[];
    };

    type Record = {
      [key: string]: string | object;
      attributes: object;
      Id: string;
      Name: string;
      DeveloperName: string;
      SObjectType: string;
    };

    const { flags } = await this.parse(ObjectDisplayRecordtypes);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    const org = flags['target-org'];
    const conn = org.getConnection();
    const sobjects = parseSObjectList(flags.sobject);
    const records: Record[] = [];

    this.spinner.start('Loading...');

    try {
      await sobjects.reduce(async (previousQuery, sobject) => {
        await previousQuery;

        const query = `SELECT SObjectType, Name, DeveloperName, Id FROM RecordType WHERE SObjectType = '${sobject}' ORDER BY DeveloperName`;
        const queryResult = (await conn.query(query)) as QueryResult;
        records.push(...queryResult.records.map((record) => ({ ...record, SObjectType: sobject })));
      }, Promise.resolve());
    } finally {
      this.spinner.stop();
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
      // Return table of fields
      ux.table(result.records, getTableColumns(includeObjectColumn));
    }

    // Return url
    if (sobjects.length === 1) {
      ux.log(`\n${conn.instanceUrl}/lightning/setup/ObjectManager/${sobjects[0]}/RecordTypes/view`);
    }

    // Return an object to be displayed with --json
    return result as unknown as ObjectDisplayRecordtypesResult;
  }
}

const getTableColumns = (
  includeObjectColumn: boolean
): {
  [key: string]: {
    header: string;
    get: (row: { SObjectType: string; Name: string; DeveloperName: string; Id: string }) => string;
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
  label: {
    header: 'Name',
    get: (row) => row.Name,
  },
  qualifiedApiName: {
    header: 'Developer Name',
    get: (row) => row.DeveloperName,
  },
  dataType: {
    header: 'Id',
    get: (row) => row.Id,
  },
});

const writeCsv = (
  filePath: string,
  records: Array<{
    SObjectType: string;
    Name: string;
    DeveloperName: string;
    Id: string;
  }>,
  includeObjectColumn: boolean
): void => {
  const columns = includeObjectColumn ? ['Object', 'Name', 'Developer Name', 'Id'] : ['Name', 'Developer Name', 'Id'];
  const rows = [
    columns.map(escapeCsvValue).join(','),
    ...records.map((record) =>
      (includeObjectColumn
        ? [record.SObjectType, record.Name, record.DeveloperName, record.Id]
        : [record.Name, record.DeveloperName, record.Id]
      )
        .map(escapeCsvValue)
        .join(',')
    ),
  ];

  writeFileSync(filePath, `${rows.join('\n')}\n`, 'utf8');
};
