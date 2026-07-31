import { Messages } from '@salesforce/core';
import { formatRecordCell, recordFormats, resolveFieldValue, type RecordFormat } from './recordQuery.js';
import { sobjectNamePattern } from './soqlComplete.js';
import { renderTable, type TableColumn } from './table.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.soql');

export type SoqlToolingMode = 'auto' | 'on' | 'off';

export const defaultSoqlAutoLimit = 2000;
export const soqlHistoryCap = 1000;

/**
 * Feeds every character to `visit` along with whether it sits inside a
 * single-quoted literal and the paren depth outside literals. Backslash
 * escapes inside literals are honoured, so `\'` does not close a string.
 */
const scanSoql = (
  input: string,
  visit?: (char: string, index: number, inString: boolean, depth: number) => void
): { inString: boolean; depth: number } => {
  let inString = false;
  let depth = 0;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (inString) {
      visit?.(char, index, true, depth);

      if (char === '\\' && index + 1 < input.length) {
        index += 1;
        visit?.(input[index], index, true, depth);
      } else if (char === "'") {
        inString = false;
      }

      continue;
    }

    if (char === "'") {
      inString = true;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    }

    visit?.(char, index, inString, depth);
  }

  return { inString, depth };
};

/** A query is ready to run once parens and single-quotes balance. */
export const isSoqlInputComplete = (input: string): boolean => {
  const { inString, depth } = scanSoql(input);

  return !inString && depth <= 0;
};

/**
 * True when the input ends inside an unterminated string literal - the one
 * spot where a `\`-prefixed continuation line is query text, not a meta-command.
 */
export const endsInsideSoqlString = (input: string): boolean => scanSoql(input).inString;

/** Collapses a multi-line query to one line, leaving string literals intact. */
export const collapseSoqlQuery = (input: string): string => {
  let collapsed = '';

  scanSoql(input, (char, _index, inString) => {
    if (!inString && /\s/.test(char)) {
      if (!collapsed.endsWith(' ')) {
        collapsed += ' ';
      }
    } else {
      collapsed += char;
    }
  });

  return collapsed.trim();
};

type SoqlWord = { word: string; index: number };

/** The bare words of the outer query - nothing inside parens or literals. */
const topLevelWords = (query: string): SoqlWord[] => {
  const words: SoqlWord[] = [];
  let current = '';
  let start = 0;

  scanSoql(query, (char, index, inString, depth) => {
    if (!inString && depth === 0 && /[A-Za-z0-9_]/.test(char)) {
      if (current === '') {
        start = index;
      }

      current += char;
    } else if (current !== '') {
      words.push({ word: current, index: start });
      current = '';
    }
  });

  if (current !== '') {
    words.push({ word: current, index: start });
  }

  return words;
};

/** The text between the outer SELECT and the outer FROM, if both exist. */
const outerSelectList = (query: string): string | undefined => {
  const words = topLevelWords(query);
  const select = words.find((entry) => entry.word.toUpperCase() === 'SELECT');
  const from = words.find((entry) => entry.word.toUpperCase() === 'FROM');

  if (select == null || from == null || from.index < select.index) {
    return undefined;
  }

  return query.slice(select.index + select.word.length, from.index);
};

/** Splits a select list on commas that sit outside parens and literals. */
const splitSelectItems = (selectList: string): string[] => {
  const items: string[] = [];
  let current = '';

  scanSoql(selectList, (char, _index, inString, depth) => {
    if (!inString && depth === 0 && char === ',') {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  });

  items.push(current);

  return items.map((item) => item.trim()).filter((item) => item.length > 0);
};

const aggregatePattern = /^(COUNT|COUNT_DISTINCT|SUM|AVG|MIN|MAX)\s*\(/i;

/**
 * A select list made up solely of aggregates returns one row - no LIMIT
 * needed - unless a GROUP BY makes it one row per group.
 */
const isBareAggregateQuery = (query: string): boolean => {
  const selectList = outerSelectList(query);

  if (selectList == null) {
    return false;
  }

  if (topLevelWords(query).some((entry) => entry.word.toUpperCase() === 'GROUP')) {
    return false;
  }

  const items = splitSelectItems(selectList);

  return items.length > 0 && items.every((item) => aggregatePattern.test(item));
};

/**
 * `SELECT COUNT() FROM ...` is the one aggregate that returns no records at
 * all - only totalSize - so the session synthesizes a row for it.
 */
export const isBareCountQuery = (query: string): boolean => {
  const selectList = outerSelectList(query);

  if (selectList == null) {
    return false;
  }

  const items = splitSelectItems(selectList);

  return items.length === 1 && /^COUNT\s*\(\s*\)$/i.test(items[0]);
};

export type AutoLimitResult = {
  soql: string;
  /** Present only when a LIMIT clause was injected. */
  injectedLimit?: number;
};

/**
 * Appends `LIMIT n` when the outer query has none and would otherwise return
 * an unbounded row set. The clause lands before any outer OFFSET or FOR
 * clause, since LIMIT must precede both.
 */
export const applySoqlAutoLimit = (query: string, limit: number): AutoLimitResult => {
  if (limit <= 0) {
    return { soql: query };
  }

  const words = topLevelWords(query);

  if (words.some((entry) => entry.word.toUpperCase() === 'LIMIT') || isBareAggregateQuery(query)) {
    return { soql: query };
  }

  const clause = `LIMIT ${limit}`;
  const insertBefore = words.find((entry) => ['OFFSET', 'FOR'].includes(entry.word.toUpperCase()));

  if (insertBefore == null) {
    return { soql: `${query.trimEnd()} ${clause}`, injectedLimit: limit };
  }

  return {
    soql: `${query.slice(0, insertBefore.index)}${clause} ${query.slice(insertBefore.index)}`,
    injectedLimit: limit,
  };
};

export type ShapedSoqlResult = {
  fields: string[];
  records: Array<Record<string, unknown>>;
};

type SelectColumn = {
  /** The key the value lives under in the returned records. */
  key: string;
  /** What the column is called in output - differs from key for exprN columns. */
  header: string;
};

const pathPattern = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const aliasPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Maps one select-list item to its result column, or undefined when the item
 * is something the simple parser does not understand (FIELDS(), TYPEOF, ...).
 */
const classifySelectItem = (item: string, nextExprKey: () => string): SelectColumn | undefined => {
  if (item.startsWith('(')) {
    const fromMatch = /\bFROM\s+([A-Za-z0-9_.]+)/i.exec(item);

    if (fromMatch == null) {
      return undefined;
    }

    const segments = fromMatch[1].split('.');
    const relationship = segments[segments.length - 1];

    return { key: relationship, header: relationship };
  }

  if (aggregatePattern.test(item)) {
    const closeIndex = findClosingParen(item);

    if (closeIndex == null) {
      return undefined;
    }

    const alias = item.slice(closeIndex + 1).trim();
    const expression = item.slice(0, closeIndex + 1);

    if (alias === '') {
      return { key: nextExprKey(), header: collapseSoqlQuery(expression) };
    }

    return aliasPattern.test(alias) ? { key: alias, header: alias } : undefined;
  }

  if (pathPattern.test(item)) {
    return { key: item, header: item };
  }

  const aliasedField = /^([A-Za-z_][A-Za-z0-9_.]*)\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(item);

  if (aliasedField != null && pathPattern.test(aliasedField[1])) {
    return { key: aliasedField[2], header: aliasedField[2] };
  }

  return undefined;
};

const findClosingParen = (item: string): number | undefined => {
  let closeIndex: number | undefined;

  scanSoql(item, (char, index, inString, depth) => {
    if (!inString && char === ')' && depth === 0 && closeIndex == null) {
      closeIndex = index;
    }
  });

  return closeIndex;
};

/**
 * Derives output columns from the query's select list - dot-notation paths
 * stay flat, unaliased aggregates get their `exprN` keys renamed to the
 * expression text. Falls back to the raw record keys whenever the select list
 * cannot be mapped onto the records with confidence.
 */
export const shapeSoqlRecords = (query: string, records: ReadonlyArray<Record<string, unknown>>): ShapedSoqlResult => {
  const selectList = outerSelectList(query);
  const items = selectList == null ? [] : splitSelectItems(selectList);
  const columns: SelectColumn[] = [];
  let exprIndex = 0;

  for (const item of items) {
    const column = classifySelectItem(item, () => `expr${exprIndex++}`);

    if (column == null) {
      return fallbackShape(records);
    }

    columns.push(column);
  }

  if (columns.length === 0) {
    return fallbackShape(records);
  }

  const renames = new Map(
    columns.filter((column) => column.key !== column.header).map((column) => [column.key, column.header])
  );
  const shapedRecords =
    renames.size === 0
      ? [...records]
      : records.map((record) =>
          Object.fromEntries(Object.entries(record).map(([key, value]) => [renames.get(key) ?? key, value]))
        );
  const fields = columns.map((column) => column.header);
  const first = shapedRecords[0];

  if (first != null && !fields.every((field) => columnPresent(first, field))) {
    return fallbackShape(shapedRecords);
  }

  return { fields, records: shapedRecords };
};

const columnPresent = (record: Record<string, unknown>, field: string): boolean =>
  field in record || field.split('.')[0] in record;

const fallbackShape = (records: ReadonlyArray<Record<string, unknown>>): ShapedSoqlResult => {
  const fields: string[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        fields.push(key);
      }
    }
  }

  return { fields, records: [...records] };
};

type IndexedRecord = { record: Record<string, unknown>; index: number };

/**
 * A query result as a column-aligned table. The REPL adds a 1-based `#`
 * column so `\open`/`\record` can address rows; one-shot output leaves it off.
 */
export const renderSoqlTable = (
  result: { fields: string[]; records: Array<Record<string, unknown>> },
  options: { indexColumn?: boolean } = {}
): string[] => {
  const rows = result.records.map((record, index) => ({ record, index }));
  const columns: Array<TableColumn<IndexedRecord>> = [
    ...(options.indexColumn === true
      ? [{ header: '#', get: (row: IndexedRecord): string => String(row.index + 1) }]
      : []),
    ...result.fields.map((field) => ({
      header: field,
      get: (row: IndexedRecord): string => formatRecordCell(resolveFieldValue(row.record, field), 0),
    })),
  ];

  return renderTable(rows, columns);
};

export type SoqlFooterSource = {
  rowCount: number;
  durationMs: number;
  usedTooling: boolean;
  injectedLimit?: number;
  injectedLimitHit: boolean;
};

/** The `N rows · Xms` footer, with auto-limit and tooling notes when relevant. */
export const buildSoqlFooter = (execution: SoqlFooterSource): string => {
  const parts = [`${execution.rowCount} row${execution.rowCount === 1 ? '' : 's'}`, `${execution.durationMs}ms`];

  if (execution.injectedLimitHit && execution.injectedLimit != null) {
    parts.push(`auto-limit ${execution.injectedLimit} hit`);
  }

  if (execution.usedTooling) {
    parts.push('via Tooling API');
  }

  return parts.join(' · ');
};

/**
 * Error lines for a failed query. The reported position refers to the query
 * as sent, so the caret is drawn against the post-injection SOQL.
 */
export const formatSoqlExecutionError = (query: string, autoLimit: number, message: string): string[] =>
  formatSoqlQueryError(applySoqlAutoLimit(query, autoLimit).soql, message);

const positionPattern = /Row:(\d+):Column:(\d+)/;

/**
 * Salesforce MALFORMED_QUERY errors carry a `Row:N:Column:M` position - when
 * one is parseable, the offending query line is echoed with a caret under the
 * column, followed by the message's explanation. Anything else passes through.
 */
export const formatSoqlQueryError = (query: string, message: string): string[] => {
  const position = positionPattern.exec(message);

  if (position == null) {
    return [message];
  }

  const line = query.split('\n')[Number(position[1]) - 1];

  if (line == null) {
    return [message];
  }

  const caretIndex = Math.min(Math.max(Number(position[2]) - 1, 0), line.length);

  return [line, `${' '.repeat(caretIndex)}^`, explanationFrom(message)];
};

/**
 * The explanation is whatever follows the `ERROR at Row` line; Salesforce
 * precedes that line with its own truncated echo of the query, which the
 * caret block above replaces.
 */
const explanationFrom = (message: string): string => {
  const lines = message.split('\n').map((line) => line.trimEnd());
  const positionIndex = lines.findIndex((line) => positionPattern.test(line));
  const after = lines.slice(positionIndex + 1).filter((line) => line.trim() !== '');

  if (after.length > 0) {
    return after.join(' ');
  }

  return lines
    .slice(0, positionIndex)
    .filter((line) => line.trim() !== '' && line.trim() !== '^')
    .join(' ');
};

/** Appends a history entry, skipping consecutive duplicates and capping length. */
export const appendSoqlHistory = (entries: readonly string[], entry: string, cap = soqlHistoryCap): string[] => {
  if (entries[entries.length - 1] === entry) {
    return [...entries];
  }

  const appended = [...entries, entry];

  return appended.slice(Math.max(0, appended.length - cap));
};

/** Splits a $PAGER/$EDITOR-style value into a command and its arguments. */
export const splitCommandLine = (value: string | undefined): { command: string; args: string[] } | undefined => {
  const parts = (value ?? '').trim().split(/\s+/);

  if (parts[0] == null || parts[0] === '') {
    return undefined;
  }

  return { command: parts[0], args: parts.slice(1) };
};

export type SoqlMetaCommand =
  | { type: 'help' }
  | { type: 'quit' }
  | { type: 'editor' }
  | { type: 'limit'; value: number }
  | { type: 'format'; value: RecordFormat }
  | { type: 'csv'; path: string }
  | { type: 'fields'; sobject: string }
  | { type: 'open'; row: number }
  | { type: 'record'; row: number }
  | { type: 'tooling'; mode: SoqlToolingMode | undefined }
  | { type: 'refresh' }
  | { type: 'invalid'; message: string };

const toolingModes: readonly SoqlToolingMode[] = ['auto', 'on', 'off'];

const invalid = (message: string): SoqlMetaCommand => ({ type: 'invalid', message });

const bareMetaCommands: Readonly<Record<string, SoqlMetaCommand>> = {
  help: { type: 'help' },
  q: { type: 'quit' },
  e: { type: 'editor' },
  refresh: { type: 'refresh' },
};

/** Parses a `\command [args]` line into a dispatchable meta-command. */
export const parseSoqlMetaLine = (line: string): SoqlMetaCommand => {
  const trimmed = line.trim().slice(1);
  const spaceIndex = trimmed.search(/\s/);
  const name = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const rest = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();
  const bare = bareMetaCommands[name];

  if (bare != null) {
    return bare;
  }

  switch (name) {
    case 'limit':
      return /^\d+$/.test(rest)
        ? { type: 'limit', value: Number(rest) }
        : invalid(messages.getMessage('error.meta.limit'));
    case 'format':
      return (recordFormats as readonly string[]).includes(rest)
        ? { type: 'format', value: rest as RecordFormat }
        : invalid(messages.getMessage('error.meta.format', [recordFormats.join(', ')]));
    case 'csv':
      return rest === '' ? invalid(messages.getMessage('error.meta.csv')) : { type: 'csv', path: rest };
    case 'fields':
      return sobjectNamePattern.test(rest)
        ? { type: 'fields', sobject: rest }
        : invalid(messages.getMessage('error.meta.fields'));
    case 'open':
    case 'record':
      return /^[1-9]\d*$/.test(rest)
        ? { type: name, row: Number(rest) }
        : invalid(messages.getMessage('error.meta.row', [`\\${name}`]));
    case 'tooling':
      if (rest === '') {
        return { type: 'tooling', mode: undefined };
      }

      return (toolingModes as readonly string[]).includes(rest)
        ? { type: 'tooling', mode: rest as SoqlToolingMode }
        : invalid(messages.getMessage('error.meta.tooling'));
    default:
      return invalid(messages.getMessage('error.meta.unknown', [`\\${name}`]));
  }
};
