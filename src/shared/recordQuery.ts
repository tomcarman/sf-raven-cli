import { Messages } from '@salesforce/core';
import { encode } from '@toon-format/toon';
import { escapeCsvValue, getEncodedQueryLength, isPlainObject, isValidSalesforceId, maxEncodedQueryLength } from './query.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.query.record');

type RecordQueryApi = {
  describeGlobal: () => Promise<{ sobjects: Array<{ name: string; keyPrefix?: string | null }> }>;
  describe: (sobjectName: string) => Promise<{ fields: Array<{ name: string; type: string; queryable?: boolean }> }>;
  query: (soql: string) => Promise<{ records: Array<Record<string, unknown>> }>;
};

export type RecordQueryConnection = RecordQueryApi & {
  tooling: RecordQueryApi;
};

export type RecordQueryOptions = {
  recordIds: string;
  fields?: string;
  extraFields?: string;
};

export type RecordQueryResult = {
  sobject: string;
  fields: string[];
  idsRequested: string[];
  idsFound: string[];
  idsNotFound: string[];
  records: Array<Record<string, unknown>>;
};

export type RecordTableOptions = {
  truncate?: number;
  omitNull?: boolean;
};

const keyPrefixLength = 3;
const shortIdLength = 15;
const defaultTruncateWidth = 80;
const columnGap = '  ';

export const queryRecords = async (connection: RecordQueryConnection, options: RecordQueryOptions): Promise<RecordQueryResult> => {
  const idsRequested = parseRecordIds(options.recordIds);
  const { api, sobject } = await detectSObject(connection, idsRequested[0]);
  const fields = await buildFieldList(api, sobject, options);

  const buildSoql = (chunkFields: string[]): string =>
    `SELECT ${chunkFields.join(', ')} FROM ${sobject} WHERE Id IN (${idsRequested.map((id) => `'${id}'`).join(', ')})`;
  const fieldChunks = buildFieldChunks(fields, buildSoql);
  const chunkResults = await Promise.all(fieldChunks.map((chunkFields) => api.query(buildSoql(chunkFields))));

  const recordsByShortId = new Map<string, Record<string, unknown>>();

  for (const chunkResult of chunkResults) {
    for (const record of chunkResult.records) {
      const shortId = toShortId(String(record.Id));
      const existing = recordsByShortId.get(shortId);
      const stripped = stripAttributes(record);
      recordsByShortId.set(shortId, existing == null ? stripped : mergeRecords(existing, stripped));
    }
  }

  const records = idsRequested
    .map((id) => recordsByShortId.get(toShortId(id)))
    .filter((record): record is Record<string, unknown> => record != null);

  return {
    sobject,
    fields,
    idsRequested,
    idsFound: records.map((record) => String(record.Id)),
    idsNotFound: idsRequested.filter((id) => !recordsByShortId.has(toShortId(id))),
    records,
  };
};

export const formatRecordTable = (result: RecordQueryResult, options: RecordTableOptions = {}): string => {
  const truncate = options.truncate ?? defaultTruncateWidth;
  const fields = options.omitNull
    ? result.fields.filter((field) => result.records.some((record) => resolveFieldValue(record, field) != null))
    : result.fields;
  const header = ['Field', ...result.records.map((record) => formatCell(record.Id, 0))];
  const rows = fields.map((field) => [
    field,
    ...result.records.map((record) => formatCell(resolveFieldValue(record, field), truncate)),
  ]);

  const widths = header.map((cell, columnIndex) => Math.max(cell.length, ...rows.map((row) => row[columnIndex].length)));
  const divider = widths.map((width) => '-'.repeat(width));

  return [header, divider, ...rows]
    .map((row) => row.map((cell, columnIndex) => cell.padEnd(widths[columnIndex])).join(columnGap).trimEnd())
    .join('\n');
};

export const formatRecordJson = (result: RecordQueryResult): string => JSON.stringify(result.records, null, 2);

export const formatRecordCsv = (result: RecordQueryResult): string => {
  const header = result.fields.map(escapeCsvValue).join(',');
  const rows = result.records.map((record) =>
    result.fields.map((field) => escapeCsvValue(resolveFieldValue(record, field))).join(',')
  );

  return [header, ...rows].join('\n');
};

export const formatRecordToon = (result: RecordQueryResult): string => encode(result.records);

const parseRecordIds = (recordIds: string): string[] => {
  const ids = recordIds
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (ids.length === 0) {
    throw messages.createError('error.noRecordIds');
  }

  const invalidIds = ids.filter((id) => !isValidSalesforceId(id));

  if (invalidIds.length > 0) {
    throw messages.createError('error.invalidRecordIds', [invalidIds.join(', ')]);
  }

  return ids;
};

const detectSObject = async (
  connection: RecordQueryConnection,
  id: string
): Promise<{ api: RecordQueryApi; sobject: string }> => {
  const keyPrefix = id.slice(0, keyPrefixLength);
  const regularSObject = await findSObjectByPrefix(connection, keyPrefix);

  if (regularSObject != null) {
    return { api: connection, sobject: regularSObject };
  }

  const toolingSObject = await findSObjectByPrefix(connection.tooling, keyPrefix);

  if (toolingSObject != null) {
    return { api: connection.tooling, sobject: toolingSObject };
  }

  throw messages.createError('error.unknownKeyPrefix', [keyPrefix]);
};

const findSObjectByPrefix = async (api: RecordQueryApi, keyPrefix: string): Promise<string | undefined> => {
  const describeGlobalResult = await api.describeGlobal();
  return describeGlobalResult.sobjects.find((candidate) => candidate.keyPrefix === keyPrefix)?.name;
};

const buildFieldList = async (
  api: RecordQueryApi,
  sobject: string,
  options: RecordQueryOptions
): Promise<string[]> => {
  const describeResult = await api.describe(sobject);

  if (options.fields != null) {
    const requested = resolveRequestedFields(options.fields, describeResult.fields, sobject);
    return ['Id', ...dedupeFields(requested.filter((field) => field !== 'Id'))];
  }

  const fullList = [
    'Id',
    ...describeResult.fields
      .filter((field) => field.queryable !== false && field.type !== 'base64')
      .map((field) => field.name)
      .filter((field) => field !== 'Id'),
  ];

  if (options.extraFields != null) {
    const known = new Set(fullList.map((field) => field.toLowerCase()));
    const extras = resolveRequestedFields(options.extraFields, describeResult.fields, sobject).filter(
      (field) => !known.has(field.toLowerCase())
    );
    return [...fullList, ...dedupeFields(extras)];
  }

  return fullList;
};

const resolveRequestedFields = (
  rawFields: string,
  describeFields: Array<{ name: string }>,
  sobject: string
): string[] => {
  const requested = rawFields
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field.length > 0);

  const canonicalByLowerName = new Map(describeFields.map((field) => [field.name.toLowerCase(), field.name]));
  const unknown: string[] = [];
  const resolved: string[] = [];

  for (const field of requested) {
    if (field.includes('.')) {
      resolved.push(field);
      continue;
    }

    const canonical = canonicalByLowerName.get(field.toLowerCase());

    if (canonical == null) {
      unknown.push(field);
    } else {
      resolved.push(canonical);
    }
  }

  if (unknown.length > 0) {
    throw messages.createError('error.unknownFields', [sobject, unknown.join(', ')]);
  }

  return resolved;
};

/**
 * Splits a field list into as few chunks as will fit the URL length limit,
 * repeating the first field (the Id) in every chunk so results can be merged.
 */
export const buildFieldChunks = (fields: string[], buildSoql: (chunkFields: string[]) => string): string[][] => {
  if (getEncodedQueryLength(buildSoql(fields)) <= maxEncodedQueryLength) {
    return [fields];
  }

  const [idField, ...remainingFields] = fields;
  const chunks: string[][] = [];
  let currentChunk: string[] = [];

  for (const field of remainingFields) {
    const candidateChunk = [...currentChunk, field];

    if (currentChunk.length > 0 && getEncodedQueryLength(buildSoql([idField, ...candidateChunk])) > maxEncodedQueryLength) {
      chunks.push([idField, ...currentChunk]);
      currentChunk = [field];
    } else {
      currentChunk = candidateChunk;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push([idField, ...currentChunk]);
  }

  return chunks.length > 0 ? chunks : [fields];
};

const mergeRecords = (base: Record<string, unknown>, addition: Record<string, unknown>): Record<string, unknown> => {
  const merged = { ...base };

  for (const [key, value] of Object.entries(addition)) {
    const existing = merged[key];
    merged[key] = isPlainObject(existing) && isPlainObject(value) ? mergeRecords(existing, value) : value;
  }

  return merged;
};

const dedupeFields = (fields: string[]): string[] => {
  const seen = new Set<string>();

  return fields.filter((field) => {
    const lower = field.toLowerCase();

    if (seen.has(lower)) {
      return false;
    }

    seen.add(lower);
    return true;
  });
};

const toShortId = (id: string): string => id.slice(0, shortIdLength);

const stripAttributes = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== 'attributes')
      .map(([key, value]) => [key, isPlainObject(value) ? stripAttributes(value) : value])
  );

const resolveFieldValue = (record: Record<string, unknown>, field: string): unknown =>
  field
    .split('.')
    .reduce<unknown>((value, segment) => (isPlainObject(value) ? value[segment] : undefined), record);

const formatCell = (value: unknown, truncate: number): string => {
  if (value == null) {
    return '';
  }

  const formatted = typeof value === 'string' ? value : JSON.stringify(value);

  if (truncate > 0 && formatted.length > truncate) {
    return `${formatted.slice(0, truncate)}…`;
  }

  return formatted;
};
