import { Messages } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { formatRecordTable, queryRecords, type RecordQueryConnection, type RecordQueryResult } from '../../../shared/recordQuery.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.query.record');

export type QueryRecordResult = {
  sobject: string;
  idsRequested: string[];
  idsFound: string[];
  records: Array<Record<string, unknown>>;
};

export default class QueryRecord extends SfCommand<QueryRecordResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: true,
    }),
    'record-ids': Flags.string({
      summary: messages.getMessage('flags.record-ids.summary'),
      char: 'i',
      required: true,
    }),
    fields: Flags.string({
      summary: messages.getMessage('flags.fields.summary'),
      char: 'f',
      exclusive: ['extra-fields'],
    }),
    'extra-fields': Flags.string({
      summary: messages.getMessage('flags.extra-fields.summary'),
      char: 'e',
      exclusive: ['fields'],
    }),
  };

  public async run(): Promise<QueryRecordResult> {
    const { flags } = await this.parse(QueryRecord);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const connection = flags['target-org'].getConnection() as unknown as RecordQueryConnection;

    this.spinner.start(messages.getMessage('info.fetching'));

    let result: RecordQueryResult;

    try {
      result = await queryRecords(connection, {
        recordIds: flags['record-ids'],
        fields: flags.fields,
        extraFields: flags['extra-fields'],
      });
    } finally {
      this.spinner.stop();
    }

    ux.log(formatRecordTable(result));

    if (result.idsNotFound.length > 0) {
      this.warn(messages.getMessage('warning.recordsNotFound', [result.idsNotFound.join(', ')]));
    }

    return {
      sobject: result.sobject,
      idsRequested: result.idsRequested,
      idsFound: result.idsFound,
      records: result.records,
    };
  }
}
