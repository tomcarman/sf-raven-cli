import chalk from 'chalk';
import type { ApexDiagnostic, ExecuteAnonymousResponse } from '@salesforce/apex-node';
import { formatLogHeader, parseLogLines } from './apexLogRender.js';

export const DEFAULT_APEX_FILE = 'scripts/apex/scratch.apex';
export const STARTER_APEX_BODY = "System.debug('hello');\n";

export type ApexRunResult = {
  success: boolean;
  compiled: boolean;
  compileProblem?: string;
  exceptionMessage?: string;
  exceptionStackTrace?: string;
  logLines: string[];
  duration: number;
};

const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export const stripAnsi = (value: string): string => value.replace(ansiPattern, '');

/**
 * apex-node reports line/column on the diagnostic rather than in the message, so
 * a compile problem is only actionable once the two are stitched back together.
 */
const describeCompileProblem = (diagnostic: ApexDiagnostic): string => {
  const { lineNumber, columnNumber, compileProblem } = diagnostic;

  if (lineNumber == null) {
    return compileProblem;
  }

  const position = columnNumber == null ? `line ${lineNumber}` : `line ${lineNumber}, column ${columnNumber}`;

  return `${compileProblem} (${position})`;
};

const firstDiagnostic = (response: ExecuteAnonymousResponse): ApexDiagnostic | undefined => response.diagnostic?.[0];

export const buildApexRunResult = (
  response: ExecuteAnonymousResponse,
  duration: number,
  filter?: string
): ApexRunResult => {
  const diagnostic = firstDiagnostic(response);
  const logLines = parseLogLines(response.logs ?? '', filter).map(stripAnsi);

  const result: ApexRunResult = {
    success: response.success,
    compiled: response.compiled,
    logLines,
    duration,
  };

  if (!response.compiled && diagnostic?.compileProblem) {
    result.compileProblem = describeCompileProblem(diagnostic);
  }

  if (response.compiled && !response.success && diagnostic != null) {
    if (diagnostic.exceptionMessage) {
      result.exceptionMessage = diagnostic.exceptionMessage;
    }

    if (diagnostic.exceptionStackTrace) {
      result.exceptionStackTrace = diagnostic.exceptionStackTrace;
    }
  }

  return result;
};

export type RenderApexRunOptions = {
  raw?: boolean;
  filter?: string;
  startedAt?: string;
};

/**
 * Builds the terminal output for one execution: the shared apex log header, then
 * either the full log body (--raw) or the colorized debug lines, then diagnostics.
 */
export const renderApexRun = (
  result: ApexRunResult,
  logs: string,
  options: RenderApexRunOptions = {}
): string[] => {
  const status = result.success ? 'Success' : 'Failed';
  const lines = [formatLogHeader('Execute Anonymous', options.startedAt ?? new Date().toISOString(), result.duration, status)];

  if (options.raw) {
    lines.push(logs);
  } else {
    // The log body carries the same exception as the diagnostic; the diagnostic
    // wins because it also has the stack trace, so drop the log's copy.
    const { exceptionMessage } = result;
    const parsed = parseLogLines(logs, options.filter).filter(
      (line) => exceptionMessage == null || !stripAnsi(line).includes(exceptionMessage)
    );

    lines.push(...parsed);
  }

  if (result.compileProblem != null) {
    lines.push(chalk.red.bold(`  ✗ Compile error: ${result.compileProblem}`));
  }

  if (result.exceptionMessage != null) {
    lines.push(chalk.red.bold(`  ✗ ${result.exceptionMessage}`));
  }

  if (result.exceptionStackTrace != null) {
    for (const frame of result.exceptionStackTrace.split('\n')) {
      lines.push(chalk.red(`    ${frame}`));
    }
  }

  lines.push('');

  return lines;
};
