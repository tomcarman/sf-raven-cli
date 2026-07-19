import { SfCommand, Flags, Ux } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import dayjs from 'dayjs';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.audit.display');

export type AuditDisplayResult = {
  result: object;
};

export default class AuditDisplay extends SfCommand<AuditDisplayResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: true,
    }),
    username: Flags.string({
      summary: messages.getMessage('flags.username.summary'),
      char: 'u',
    }),
    limit: Flags.integer({
      summary: messages.getMessage('flags.limit.summary'),
      char: 'l',
      min: 1,
      max: 2000,
      default: 20,
    }),
  };

  public async run(): Promise<AuditDisplayResult> {
    this.spinner.start('Loading...');

    type QueryResult = {
      totalSize: number;
      done: boolean;
      records: Record[];
    };

    type Record = {
      [key: string]: string | object;
      attributes: object;
      CreatedDate: string;
      CreatedBy: {
        Username: string;
      };
      Section: string;
      Display: string;
      DelegateUser: string;
    };

    const { flags } = await this.parse(AuditDisplay);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    const org = flags['target-org'];
    const conn = org.getConnection();
    let query = '';

    if (flags.username) {
      query = `SELECT CreatedDate, CreatedBy.Username, 
                      Section, Display, DelegateUser 
                FROM SetupAuditTrail 
                WHERE CreatedBy.Username = '${flags.username}'
                ORDER BY CreatedDate DESC 
                LIMIT ${flags.limit}`;
    } else {
      query = `SELECT CreatedDate, CreatedBy.Username, 
                      Section, Display, DelegateUser 
                FROM SetupAuditTrail 
                ORDER BY CreatedDate DESC 
                LIMIT ${flags.limit}`;
    }

    const result = (await conn.query(query)) as QueryResult;

    result.records.forEach((record) => {
      record.CreatedDate = dayjs(record.CreatedDate).format('YYYY-MM-DD HH:mm:ss');
    });

    this.spinner.stop();

    // Return table of fields
    ux.table(result.records, {
      createdDate: {
        header: 'Date',
        get: (row: Record) => row.CreatedDate,
      },
      createdBy: {
        header: 'Username',
        get: (row: Record) => row.CreatedBy?.Username,
      },
      section: {
        header: 'Type',
        get: (row: Record) => row.Section,
      },
      display: {
        header: 'Action',
        get: (row: Record) => row.Display,
      },
      delegateUser: {
        header: 'Delegate User',
        get: (row: Record) => row.DelegateUser,
      },
    });

    return result as unknown as AuditDisplayResult;
  }
}
