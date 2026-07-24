import { isValidSalesforceId } from './query.js';

export type RecordQueryConnection = {
  describeGlobal: () => Promise<{ sobjects: Array<{ name: string; keyPrefix?: string | null }> }>;
  describe: (sobjectName: string) => Promise<{ fields: Array<{ name: string; type: string; queryable?: boolean }> }>;
  query: (soql: string) => Promise<{ records: Array<Record<string, unknown>> }>;
};

export type RecordQueryOptions = {
  recordIds: string;
};

export type RecordQueryResult = {
  sobject: string;
  fields: string[];
  idsRequested: string[];
  idsFound: string[];
  records: Array<Record<string, unknown>>;
};

export type RecordTableOptions = {
  truncate?: number;
};

const keyPrefixLength = 3;
const defaultTruncateWidth = 80;
const columnGap = '  ';

export const queryRecords = async (connection: RecordQueryConnection, options: RecordQueryOptions): Promise<RecordQueryResult> => {
  const idsRequested = parseRecordIds(options.recordIds);
  const sobject = await detectSObject(connection, idsRequested[0]);
  const fields = await buildFieldList(connection, sobject);

  const soql = `SELECT ${fields.join(', ')} FROM ${sobject} WHERE Id IN (${idsRequested.map((id) => `'${id}'`).join(', ')})`;
  const queryResult = await connection.query(soql);
  const records = queryResult.records.map((record) => stripAttributes(record));

  return {
    sobject,
    fields,
    idsRequested,
    idsFound: records.map((record) => String(record.Id)),
    records,
  };
};

export const formatRecordTable = (result: RecordQueryResult, options: RecordTableOptions = {}): string => {
  const truncate = options.truncate ?? defaultTruncateWidth;
  const header = ['Field', ...result.records.map((record) => formatCell(record.Id, truncate))];
  const rows = result.fields.map((field) => [field, ...result.records.map((record) => formatCell(record[field], truncate))]);

  const widths = header.map((cell, columnIndex) => Math.max(cell.length, ...rows.map((row) => row[columnIndex].length)));
  const divider = widths.map((width) => '-'.repeat(width));

  return [header, divider, ...rows]
    .map((row) => row.map((cell, columnIndex) => cell.padEnd(widths[columnIndex])).join(columnGap).trimEnd())
    .join('\n');
};

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

const buildFieldList = async (connection: RecordQueryConnection, sobject: string): Promise<string[]> => {
  const describeResult = await connection.describe(sobject);
  const fields = describeResult.fields
    .filter((field) => field.queryable !== false && field.type !== 'base64')
    .map((field) => field.name);

  return ['Id', ...fields.filter((field) => field !== 'Id')];
};

const stripAttributes = (record: Record<string, unknown>): Record<string, unknown> => {
  const stripped = { ...record };

  delete stripped.attributes;

  return stripped;
};

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
