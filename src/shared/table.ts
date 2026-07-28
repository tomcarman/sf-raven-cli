import chalk from 'chalk';

const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export const stripAnsi = (value: string): string => value.replace(ansiPattern, '');

export type TableColumn<T> = {
  header: string;
  get: (row: T) => string;
};

export type RenderTableOptions<T> = {
  /** An extra line printed beneath a row, indented and dimmed. */
  note?: (row: T) => string | undefined;
};

/**
 * A plain column-aligned table. Unlike `ux.table` it can interleave a note line
 * beneath individual rows, which is how failures explain themselves in place.
 * Widths are measured with colour codes stripped so styled cells still line up.
 */
export const renderTable = <T>(
  rows: readonly T[],
  columns: ReadonlyArray<TableColumn<T>>,
  options: RenderTableOptions<T> = {}
): string[] => {
  const cells = rows.map((row) => columns.map((column) => column.get(row)));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((rowCells) => stripAnsi(rowCells[index]).length))
  );

  const line = (values: readonly string[]): string =>
    values
      .map((value, index) => pad(value, widths[index]))
      .join('  ')
      .trimEnd();

  const lines = [chalk.bold(line(columns.map((column) => column.header)))];

  rows.forEach((row, index) => {
    lines.push(line(cells[index]));

    const note = options.note?.(row);

    if (note != null && note.length > 0) {
      lines.push(chalk.dim(`    ${note}`));
    }
  });

  return lines;
};

const pad = (value: string, width: number): string => value + ' '.repeat(Math.max(0, width - stripAnsi(value).length));
