import { readFileSync, writeFileSync } from 'node:fs';
import { Messages } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import {
  escapeCsvValue,
  getEncodedQueryLength,
  isPlainObject,
  isValidSalesforceId,
  maxEncodedQueryLength,
} from '../../../shared/query.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.query.ids');

const idsPlaceholder = '{ids}';

export type QueryIdsResult = {
  totalRows: number;
  validIds: number;
  uniqueIds: number;
  duplicateIds: number;
  limit?: number;
  processedIds: number;
  batches: number;
  recordsReturned: number;
  records: QueryRecord[];
};

type QueryRecord = Record<string, unknown>;

type QueryResult = {
  records: QueryRecord[];
  done: boolean;
  nextRecordsUrl?: string;
};

type ParsedIds = {
  totalRows: number;
  uniqueIds: string[];
  duplicateIds: number;
};

export default class QueryIds extends SfCommand<QueryIdsResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.optionalOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
    }),
    file: Flags.file({
      summary: messages.getMessage('flags.file.summary'),
      char: 'f',
      required: true,
      exists: true,
    }),
    query: Flags.string({
      summary: messages.getMessage('flags.query.summary'),
      char: 'q',
      required: true,
    }),
    'batch-size': Flags.integer({
      summary: messages.getMessage('flags.batch-size.summary'),
      char: 'b',
      min: 1,
    }),
    csv: Flags.file({
      summary: messages.getMessage('flags.csv.summary'),
      char: 'c',
      required: false,
    }),
    limit: Flags.integer({
      summary: messages.getMessage('flags.limit.summary'),
      char: 'l',
      min: 1,
    }),
  };

  public async run(): Promise<QueryIdsResult> {
    const { flags } = await this.parse(QueryIds);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const org = flags['target-org'];

    if (org == null) {
      throw messages.createError('error.noTargetOrg');
    }

    validateQuery(flags.query);

    const parsedIds = parseIdsFromFile(flags.file);
    const processedIds = flags.limit == null ? parsedIds.uniqueIds : parsedIds.uniqueIds.slice(0, flags.limit);

    if (processedIds.length === 0) {
      throw messages.createError('error.noIds');
    }

    const batches =
      flags['batch-size'] == null
        ? buildAutomaticBatches(processedIds, flags.query)
        : buildFixedBatches(processedIds, flags['batch-size']);
    const connection = org.getConnection() as unknown as QueryConnection;
    const records: QueryRecord[] = [];

    await batches.reduce(async (previousBatch, batch, index) => {
      await previousBatch;
      ux.spinner.start(messages.getMessage('info.queryingBatch', [(index + 1).toString(), batches.length.toString()]));

      try {
        const batchRecords = await runQuery(connection, buildQuery(flags.query, batch));
        records.push(...batchRecords);
      } finally {
        ux.spinner.stop();
      }
    }, Promise.resolve());

    const flattenedRecords = records.map((record) => flattenRecord(record));

    if (flags.csv != null) {
      writeCsv(flags.csv, flattenedRecords);
      ux.log(messages.getMessage('info.csvWritten', [records.length.toString(), flags.csv]));
    } else {
      renderTable(ux, flattenedRecords);
    }

    ux.log(
      messages.getMessage('info.summary', [
        processedIds.length.toString(),
        batches.length.toString(),
        records.length.toString(),
        parsedIds.duplicateIds.toString(),
      ])
    );

    return {
      totalRows: parsedIds.totalRows,
      validIds: parsedIds.uniqueIds.length,
      uniqueIds: parsedIds.uniqueIds.length,
      duplicateIds: parsedIds.duplicateIds,
      limit: flags.limit,
      processedIds: processedIds.length,
      batches: batches.length,
      recordsReturned: records.length,
      records,
    };
  }
}

const parseIdsFromFile = (filePath: string): ParsedIds => {
  const rows = readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0);
  const uniqueIds: string[] = [];
  const seenIds = new Set<string>();
  let duplicateIds = 0;

  for (const row of rows) {
    if (!isValidSalesforceId(row)) {
      throw messages.createError('error.invalidId', [row]);
    }

    if (seenIds.has(row)) {
      duplicateIds += 1;
    } else {
      uniqueIds.push(row);
      seenIds.add(row);
    }
  }

  return {
    totalRows: rows.length,
    uniqueIds,
    duplicateIds,
  };
};

const validateQuery = (query: string): void => {
  const placeholderCount = query.split(idsPlaceholder).length - 1;

  if (placeholderCount !== 1) {
    throw messages.createError('error.invalidPlaceholder', [idsPlaceholder]);
  }
};

const buildFixedBatches = (ids: string[], batchSize: number): string[][] => {
  const batches: string[][] = [];

  for (let index = 0; index < ids.length; index += batchSize) {
    batches.push(ids.slice(index, index + batchSize));
  }

  return batches;
};

const buildAutomaticBatches = (ids: string[], query: string): string[][] => {
  const batches: string[][] = [];
  let currentBatch: string[] = [];

  for (const id of ids) {
    const candidateBatch = [...currentBatch, id];

    if (getEncodedQueryLength(buildQuery(query, candidateBatch)) > maxEncodedQueryLength) {
      if (currentBatch.length === 0) {
        throw messages.createError('error.queryTooLongForSingleId', [id]);
      }

      batches.push(currentBatch);
      currentBatch = [id];
    } else {
      currentBatch = candidateBatch;
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
};

const buildQuery = (query: string, ids: string[]): string =>
  query.replace(idsPlaceholder, `(${ids.map((id) => `'${id}'`).join(', ')})`);

const runQuery = async (connection: QueryConnection, query: string): Promise<QueryRecord[]> => {
  const records: QueryRecord[] = [];
  const result = await connection.query(query);
  records.push(...result.records);

  await queryMoreRecords(connection, result, records);

  return records;
};

type QueryConnection = {
  query: (query: string) => Promise<QueryResult>;
  queryMore: (nextRecordsUrl: string) => Promise<QueryResult>;
};

const queryMoreRecords = async (
  connection: QueryConnection,
  result: QueryResult,
  records: QueryRecord[]
): Promise<void> => {
  if (result.done || result.nextRecordsUrl == null) {
    return;
  }

  const nextResult = await connection.queryMore(result.nextRecordsUrl);
  records.push(...nextResult.records);
  await queryMoreRecords(connection, nextResult, records);
};

const flattenRecord = (record: QueryRecord): QueryRecord => {
  const flattenedRecord = flattenValue(record, '');

  delete flattenedRecord.attributes;

  return flattenedRecord;
};

const flattenValue = (value: unknown, prefix: string): QueryRecord => {
  if (isPlainObject(value)) {
    const flattenedRecord: QueryRecord = {};

    for (const [key, childValue] of Object.entries(value)) {
      if (key === 'attributes') {
        continue;
      }

      Object.assign(flattenedRecord, flattenValue(childValue, prefix.length === 0 ? key : `${prefix}.${key}`));
    }

    return flattenedRecord;
  } else {
    return {
      [prefix]: value,
    };
  }
};

const renderTable = (ux: Ux, records: QueryRecord[]): void => {
  if (records.length === 0) {
    ux.log(messages.getMessage('info.noRecords'));
    return;
  }

  const columns = getColumns(records);
  ux.table(
    records,
    Object.fromEntries(columns.map((column) => [column, { header: column, get: (row: QueryRecord) => row[column] }]))
  );
};

const getColumns = (records: QueryRecord[]): string[] => {
  const columns = new Set<string>();

  for (const record of records) {
    for (const key of Object.keys(record)) {
      columns.add(key);
    }
  }

  return Array.from(columns);
};

const writeCsv = (filePath: string, records: QueryRecord[]): void => {
  const columns = getColumns(records);
  const rows = [columns.map(escapeCsvValue).join(',')];

  for (const record of records) {
    rows.push(columns.map((column) => escapeCsvValue(record[column])).join(','));
  }

  writeFileSync(filePath, `${rows.join('\n')}\n`, 'utf8');
};
