import chalk from 'chalk';
import dayjs from 'dayjs';

export const parseLogLines = (body: string, filter?: string): string[] => {
  const result: string[] = [];

  for (const line of body.split('\n')) {
    if (line.includes('|USER_DEBUG|')) {
      const parts = line.split('|');

      if (parts.length >= 5) {
        const lineNum = parts[2];
        const level = parts[3];
        const message = parts.slice(4).join('|');

        if (filter == null || message.includes(filter)) {
          result.push(`  ${chalk.dim(lineNum.padEnd(5))} ${formatLevel(level)}  ${message}`);
        }
      }
    } else if (line.includes('|EXCEPTION_THROWN|') || line.includes('|FATAL_ERROR|')) {
      const parts = line.split('|');
      result.push(chalk.red(`  ⚠  ${parts.slice(2).join('|')}`));
    }
  }

  return result;
};

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
