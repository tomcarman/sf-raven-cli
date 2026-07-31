import { stripAttributes } from './recordQuery.js';
import { applySoqlAutoLimit, isBareCountQuery, shapeSoqlRecords, type SoqlToolingMode } from './soqlRepl.js';

export type SoqlQueryResponse = {
  totalSize: number;
  done: boolean;
  records: Array<Record<string, unknown>>;
};

export type SoqlQueryApi = {
  query: (soql: string) => Promise<SoqlQueryResponse>;
};

export type SoqlConnection = SoqlQueryApi & {
  tooling: SoqlQueryApi;
};

export type SoqlExecutionOptions = {
  /** LIMIT injected into unbounded queries; 0 disables injection. */
  autoLimit: number;
  toolingMode: SoqlToolingMode;
};

export type SoqlExecution = {
  /** The query as the user wrote it. */
  query: string;
  /** The query as sent, after any LIMIT injection. */
  soql: string;
  fields: string[];
  records: Array<Record<string, unknown>>;
  rowCount: number;
  totalSize: number;
  durationMs: number;
  usedTooling: boolean;
  injectedLimit?: number;
  /** True when the injected LIMIT was what stopped the result. */
  injectedLimitHit: boolean;
};

/**
 * Runs one query through the whole pipeline: auto-LIMIT, Tooling API routing
 * with INVALID_TYPE fallback, attribute stripping, and select-list-driven
 * column shaping.
 */
export const executeSoql = async (
  connection: SoqlConnection,
  query: string,
  options: SoqlExecutionOptions
): Promise<SoqlExecution> => {
  const { soql, injectedLimit } = applySoqlAutoLimit(query, options.autoLimit);
  const startedAt = Date.now();
  const { response, usedTooling } = await runQuery(connection, soql, options.toolingMode);
  const durationMs = Date.now() - startedAt;

  let records = (response.records ?? []).map(stripAttributes);

  if (records.length === 0 && isBareCountQuery(query)) {
    records = [{ 'COUNT()': response.totalSize }];
  }

  const shaped = shapeSoqlRecords(query, records);

  return {
    query,
    soql,
    fields: shaped.fields,
    records: shaped.records,
    rowCount: shaped.records.length,
    totalSize: response.totalSize,
    durationMs,
    usedTooling,
    ...(injectedLimit == null ? {} : { injectedLimit }),
    injectedLimitHit: injectedLimit != null && shaped.records.length >= injectedLimit,
  };
};

const runQuery = async (
  connection: SoqlConnection,
  soql: string,
  toolingMode: SoqlToolingMode
): Promise<{ response: SoqlQueryResponse; usedTooling: boolean }> => {
  if (toolingMode === 'on') {
    return { response: await connection.tooling.query(soql), usedTooling: true };
  }

  try {
    return { response: await connection.query(soql), usedTooling: false };
  } catch (error) {
    if (toolingMode === 'auto' && isInvalidTypeError(error)) {
      return { response: await connection.tooling.query(soql), usedTooling: true };
    }

    throw error;
  }
};

/**
 * jsforce surfaces the Salesforce error code as `errorCode` (and sometimes as
 * the error name); the message-text check covers whatever slips through.
 */
const isInvalidTypeError = (error: unknown): boolean => {
  if (error == null || typeof error !== 'object') {
    return false;
  }

  const { errorCode, name, message } = error as { errorCode?: string; name?: string; message?: string };

  return errorCode === 'INVALID_TYPE' || name === 'INVALID_TYPE' || (message ?? '').includes('INVALID_TYPE');
};
