import { Messages } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import {
  formatRecordCsv,
  formatRecordJson,
  formatRecordTable,
  formatRecordToon,
  queryRecords,
  type RecordQueryConnection,
  type RecordQueryResult,
  type RecordTableOptions,
} from '../../../shared/recordQuery.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.query.record');

export type QueryRecordResult = Pick<RecordQueryResult, 'sobject' | 'idsRequested' | 'idsFound' | 'records'>;

const recordFormats = ['table', 'json', 'csv', 'toon'] as const;
type RecordFormat = (typeof recordFormats)[number];

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
    'omit-null': Flags.boolean({
      summary: messages.getMessage('flags.omit-null.summary'),
      default: false,
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

    ux.log(formatRecordOutput(result, flags.format, { truncate: flags.truncate, omitNull: flags['omit-null'] }));

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

const formatRecordOutput = (
  result: RecordQueryResult,
  format: RecordFormat,
  tableOptions: RecordTableOptions
): string => {
  switch (format) {
    case 'json':
      return formatRecordJson(result);
    case 'csv':
      return formatRecordCsv(result);
    case 'toon':
      return formatRecordToon(result);
    default:
      return formatRecordTable(result, tableOptions);
  }
};
