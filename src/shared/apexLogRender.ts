import chalk from 'chalk';
import dayjs from 'dayjs';

export type DebugLogEntry = {
  kind: 'debug';
  line: number;
  level: string;
  message: string;
};

export type ExceptionLogEntry = {
  kind: 'exception';
  message: string;
};

export type LogEntry = DebugLogEntry | ExceptionLogEntry;

export const parseLogEntries = (body: string): LogEntry[] => {
  const entries: LogEntry[] = [];

  for (const line of body.split('\n')) {
    if (line.includes('|USER_DEBUG|')) {
      const parts = line.split('|');

      if (parts.length >= 5) {
        entries.push({
          kind: 'debug',
          line: Number(parts[2].slice(1, -1)),
          level: parts[3],
          message: parts.slice(4).join('|'),
        });
      }
    } else if (line.includes('|EXCEPTION_THROWN|') || line.includes('|FATAL_ERROR|')) {
      entries.push({ kind: 'exception', message: line.split('|').slice(2).join('|') });
    }
  }

  return entries;
};

/**
 * Formats one entry for the terminal. Exceptions are always shown; the filter
 * only applies to debug messages.
 */
export const formatLogEntry = (entry: LogEntry): string =>
  entry.kind === 'debug'
    ? `  ${chalk.dim(`[${entry.line}]`.padEnd(5))} ${formatLevel(entry.level)}  ${entry.message}`
    : chalk.red(`  ⚠  ${entry.message}`);

export const parseLogLines = (body: string, filter?: string): string[] =>
  parseLogEntries(body)
    .filter((entry) => filter == null || entry.kind === 'exception' || entry.message.includes(filter))
    .map(formatLogEntry);

export const formatLevel = (level: string): string => {
  const padded = level.padEnd(7);
  switch (level) {
    case 'ERROR':
      return chalk.red.bold(padded);
    case 'WARN':
      return chalk.yellow(padded);
    case 'INFO':
      return chalk.cyan(padded);
    case 'FINE':
    case 'FINER':
    case 'FINEST':
      return chalk.dim(padded);
    default:
      return chalk.dim(padded); // DEBUG
  }
};

export const formatLogHeader = (
  operation: string | undefined,
  createdDate: string | undefined,
  duration: number | undefined,
  status: string | undefined
): string => {
  const time = dayjs(createdDate).format('HH:mm:ss');
  const op = operation ?? 'Log';
  const durationStr = duration != null ? `  ${duration}ms` : '';
  const failed = status != null && status !== 'Success' ? ' ' + chalk.red.bold(`[${status}]`) : '';
  return `\n${chalk.dim('──')} ${chalk.bold.cyan(op)}  ${chalk.dim(`${time}${durationStr}`)}${failed} ${chalk.dim(
    '──'
  )}`;
};
