import { encode } from '@toon-format/toon';
import { escapeCsvValue, isValidSalesforceId } from './query.js';

export type RecordQueryConnection = {
  describeGlobal: () => Promise<{ sobjects: Array<{ name: string; keyPrefix?: string | null }> }>;
  describe: (sobjectName: string) => Promise<{ fields: Array<{ name: string; type: string; queryable?: boolean }> }>;
  query: (soql: string) => Promise<{ records: Array<Record<string, unknown>> }>;
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
  const sobject = await detectSObject(connection, idsRequested[0]);
  const fields = await buildFieldList(connection, sobject, options);

  const soql = `SELECT ${fields.join(', ')} FROM ${sobject} WHERE Id IN (${idsRequested.map((id) => `'${id}'`).join(', ')})`;
  const queryResult = await connection.query(soql);
  const recordsByShortId = new Map(
    queryResult.records.map((record) => [toShortId(String(record.Id)), stripAttributes(record)])
  );

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
  const header = ['Field', ...result.records.map((record) => formatCell(record.Id, truncate))];
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
    throw new Error('No record ids were supplied.');
  }

  const invalidIds = ids.filter((id) => !isValidSalesforceId(id));

  if (invalidIds.length > 0) {
    throw new Error(`Invalid Salesforce record id(s): ${invalidIds.join(', ')}. Ids must be 15 or 18 alphanumeric characters.`);
  }

  return ids;
};

const detectSObject = async (connection: RecordQueryConnection, id: string): Promise<string> => {
  const keyPrefix = id.slice(0, keyPrefixLength);
  const describeGlobalResult = await connection.describeGlobal();
  const sobject = describeGlobalResult.sobjects.find((candidate) => candidate.keyPrefix === keyPrefix);

  if (sobject == null) {
    throw new Error(`No object with key prefix '${keyPrefix}' was found in the org.`);
  }

  return sobject.name;
};

const buildFieldList = async (
  connection: RecordQueryConnection,
  sobject: string,
  options: RecordQueryOptions
): Promise<string[]> => {
  const describeResult = await connection.describe(sobject);

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
    throw new Error(`Unknown field(s) for ${sobject}: ${unknown.join(', ')}.`);
  }

  return resolved;
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

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
