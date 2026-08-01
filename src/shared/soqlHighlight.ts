/**
 * Live syntax highlighting for the SOQL REPL's line editor, driven by the
 * completion engine's lexer so both features tokenize identically. Colors are
 * ANSI-only decoration: the visible width of the line never changes, which
 * the editor's cursor math depends on.
 */
import chalk from 'chalk';
import { scanSoql, type ScanString, type ScanWord } from './soqlComplete.js';

/**
 * Context the current line inherits from earlier continuation lines: when
 * they end inside an unterminated string literal, this whole line starts as
 * string text until a quote closes it.
 */
export type SoqlHighlightContext = { openString?: boolean };

const soqlKeywords = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'INCLUDES',
  'EXCLUDES',
  'ORDER',
  'GROUP',
  'BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'ASC',
  'DESC',
  'NULLS',
  'FIRST',
  'LAST',
  'TRUE',
  'FALSE',
  'NULL',
  'WITH',
  'USING',
  'SCOPE',
  'TYPEOF',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'FOR',
  'UPDATE',
  'VIEW',
  'REFERENCE',
  'TRACKING',
  'VIEWSTAT',
  'SECURITY_ENFORCED',
  'USER_MODE',
  'SYSTEM_MODE',
  'ROLLUP',
  'CUBE',
  'ALL',
  'ROWS',
  'DATA',
  'CATEGORY',
  'AT',
  'ABOVE',
  'BELOW',
  'ABOVE_OR_BELOW',
]);

const soqlFunctions = new Set([
  // Aggregates
  'AVG',
  'COUNT',
  'COUNT_DISTINCT',
  'MAX',
  'MIN',
  'SUM',
  // Date functions
  'CALENDAR_MONTH',
  'CALENDAR_QUARTER',
  'CALENDAR_YEAR',
  'DAY_IN_MONTH',
  'DAY_IN_WEEK',
  'DAY_IN_YEAR',
  'DAY_ONLY',
  'FISCAL_MONTH',
  'FISCAL_QUARTER',
  'FISCAL_YEAR',
  'HOUR_IN_DAY',
  'WEEK_IN_MONTH',
  'WEEK_IN_YEAR',
]);

const soqlDateLiterals = new Set([
  'YESTERDAY',
  'TODAY',
  'TOMORROW',
  'LAST_WEEK',
  'THIS_WEEK',
  'NEXT_WEEK',
  'LAST_MONTH',
  'THIS_MONTH',
  'NEXT_MONTH',
  'LAST_90_DAYS',
  'NEXT_90_DAYS',
  'LAST_N_DAYS',
  'NEXT_N_DAYS',
  'N_DAYS_AGO',
  'LAST_N_WEEKS',
  'NEXT_N_WEEKS',
  'N_WEEKS_AGO',
  'LAST_N_MONTHS',
  'NEXT_N_MONTHS',
  'N_MONTHS_AGO',
  'THIS_QUARTER',
  'LAST_QUARTER',
  'NEXT_QUARTER',
  'LAST_N_QUARTERS',
  'NEXT_N_QUARTERS',
  'N_QUARTERS_AGO',
  'THIS_YEAR',
  'LAST_YEAR',
  'NEXT_YEAR',
  'LAST_N_YEARS',
  'NEXT_N_YEARS',
  'N_YEARS_AGO',
  'THIS_FISCAL_QUARTER',
  'LAST_FISCAL_QUARTER',
  'NEXT_FISCAL_QUARTER',
  'LAST_N_FISCAL_QUARTERS',
  'NEXT_N_FISCAL_QUARTERS',
  'N_FISCAL_QUARTERS_AGO',
  'THIS_FISCAL_YEAR',
  'LAST_FISCAL_YEAR',
  'NEXT_FISCAL_YEAR',
  'LAST_N_FISCAL_YEARS',
  'NEXT_N_FISCAL_YEARS',
  'N_FISCAL_YEARS_AGO',
]);

type Colorize = (text: string) => string;

/**
 * SOQL identifiers cannot start with a digit, so any word that does is part
 * of a number or date/datetime literal (`2026`, `31T00`, `123`).
 */
const wordColor = (word: ScanWord): Colorize | undefined => {
  const upper = word.text.toUpperCase();

  if (soqlKeywords.has(upper)) {
    return chalk.bold.cyan;
  }

  if (soqlFunctions.has(upper)) {
    return chalk.magenta;
  }

  if (soqlDateLiterals.has(upper) || /^\d/.test(word.text)) {
    return chalk.yellow;
  }

  return undefined;
};

type Span = { start: number; end: number; color: Colorize };

const stringSpan = (literal: ScanString, textLength: number): Span => ({
  start: literal.open,
  end: literal.close == null ? textLength : literal.close + 1,
  color: chalk.green,
});

/**
 * Colors one physical line of SOQL. When `openString` says the previous lines
 * left a string literal open, the line is scanned with a virtual opening
 * quote so its leading text colors as the string it is.
 */
export const highlightSoql = (line: string, context: SoqlHighlightContext = {}): string => {
  const offset = context.openString === true ? 1 : 0;
  const text = context.openString === true ? `'${line}` : line;
  const state = scanSoql(text);

  const spans: Span[] = [
    ...state.strings.map((literal) => stringSpan(literal, text.length)),
    ...state.words.flatMap((word) => {
      const color = wordColor(word);

      return color == null ? [] : [{ start: word.start, end: word.end, color }];
    }),
  ].sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = offset;

  for (const span of spans) {
    const start = Math.max(span.start, offset);

    if (start >= span.end) {
      continue;
    }

    out += text.slice(cursor, start);
    out += span.color(text.slice(start, span.end));
    cursor = span.end;
  }

  return out + text.slice(cursor);
};
