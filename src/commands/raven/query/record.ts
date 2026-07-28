import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import chalk from 'chalk';
import {
  buildHistoryQuery,
  findHistoryRelationship,
  formatHistoryDate,
  formatHistoryValue,
  groupHistoryByRecord,
  type ChildRelationship,
  type HistoryRecord,
  type HistoryRow,
} from '../../../shared/recordHistory.js';
import { renderTable, type TableColumn } from '../../../shared/table.js';
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

export type QueryRecordResult = Pick<RecordQueryResult, 'sobject' | 'idsRequested' | 'idsFound' | 'records'> & {
  /** Field history rows keyed by record Id, present only with --history. */
  history?: Record<string, HistoryRow[]>;
};

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
    history: Flags.boolean({
      summary: messages.getMessage('flags.history.summary'),
      default: false,
    }),
  };

  public async run(): Promise<QueryRecordResult> {
    const { flags } = await this.parse(QueryRecord);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const org = flags['target-org'];
    const connection = org.getConnection() as unknown as RecordQueryConnection;

    if (flags.history && (flags.format === 'csv' || flags.format === 'toon')) {
      throw messages.createError('error.historyFormat', [flags.format]);
    }

    ux.spinner.start(messages.getMessage('info.fetching'));

    let result: RecordQueryResult;

    try {
      result = await queryRecords(connection, {
        recordIds: flags['record-ids'],
        fields: flags.fields,
        extraFields: flags['extra-fields'],
      });
    } finally {
      ux.spinner.stop();
    }

    const history = flags.history ? await this.loadHistory(org.getConnection(), result) : undefined;

    ux.log(
      formatRecordOutput(result, flags.format, { truncate: flags.truncate, omitNull: flags['omit-null'] }, history)
    );

    if (history != null && flags.format === 'table') {
      for (const line of renderHistorySections(result.idsFound, history)) {
        ux.log(line);
      }
    }

    if (result.idsNotFound.length > 0) {
      this.warn(messages.getMessage('warning.recordsNotFound', [result.idsNotFound.join(', ')]));
    }

    return {
      sobject: result.sobject,
      idsRequested: result.idsRequested,
      idsFound: result.idsFound,
      records: result.records,
      ...(history == null ? {} : { history }),
    };
  }

  /**
   * Field history lives on a separate child object whose name varies by object,
   * so it is discovered from describe. Tracking being switched off is a warning,
   * not a failure - the record table is still worth printing.
   */
  private async loadHistory(
    connection: Connection,
    result: RecordQueryResult
  ): Promise<Record<string, HistoryRow[]> | undefined> {
    if (result.usedTooling) {
      this.warn(messages.getMessage('warning.noHistory', [result.sobject]));
      return undefined;
    }

    const described = (await connection.describe(result.sobject)) as unknown as {
      childRelationships?: ChildRelationship[];
    };

    const relationship = findHistoryRelationship(result.sobject, described.childRelationships ?? []);

    if (relationship == null) {
      this.warn(messages.getMessage('warning.noHistory', [result.sobject]));
      return undefined;
    }

    if (result.idsFound.length === 0) {
      return {};
    }

    const historyResult = await connection.query<HistoryRecord>(buildHistoryQuery(relationship, result.idsFound));

    return groupHistoryByRecord(historyResult.records, relationship.field, result.idsFound);
  }
}

const formatRecordOutput = (
  result: RecordQueryResult,
  format: RecordFormat,
  tableOptions: RecordTableOptions,
  history: Record<string, HistoryRow[]> | undefined
): string => {
  switch (format) {
    case 'json':
      return history == null
        ? formatRecordJson(result)
        : JSON.stringify({ records: result.records, history }, null, 2);
    case 'csv':
      return formatRecordCsv(result);
    case 'toon':
      return formatRecordToon(result);
    default:
      return formatRecordTable(result, tableOptions);
  }
};

const renderHistorySections = (
  recordIds: readonly string[],
  history: Record<string, HistoryRow[]>
): string[] => {
  const lines: string[] = [];

  for (const recordId of recordIds) {
    const rows = history[recordId] ?? [];

    lines.push('', chalk.bold(recordId), '');

    if (rows.length === 0) {
      lines.push(messages.getMessage('info.noHistoryRows'));
      continue;
    }

    lines.push(...renderTable(rows, historyColumns));
  }

  return lines;
};

const historyColumns: Array<TableColumn<HistoryRow>> = [
  { header: 'Date', get: (row) => formatHistoryDate(row.date) },
  { header: 'Field', get: (row) => row.field },
  { header: 'Old Value', get: (row) => formatHistoryValue(row.oldValue, row.isEvent) },
  { header: 'New Value', get: (row) => formatHistoryValue(row.newValue, row.isEvent) },
  { header: 'Changed By', get: (row) => row.changedBy },
];
