import assert from 'node:assert/strict';
import chalk from 'chalk';
import { renderTable, stripAnsi } from '../../src/shared/table.js';

type Row = { name: string; count: string; note?: string };

const columns = [
  { header: 'Name', get: (row: Row): string => row.name },
  { header: 'Count', get: (row: Row): string => row.count },
];

describe('renderTable', () => {
  it('pads every column to its widest cell', () => {
    const lines = renderTable(
      [
        { name: 'a', count: '1' },
        { name: 'longer name', count: '22' },
      ],
      columns
    ).map(stripAnsi);

    assert.deepEqual(lines, ['Name         Count', 'a            1', 'longer name  22']);
  });

  it('sizes a column by its header when every cell is shorter', () => {
    const lines = renderTable([{ name: 'a', count: '1' }], columns).map(stripAnsi);

    assert.equal(lines[1], 'a     1');
  });

  it('ignores colour codes when measuring width', () => {
    const lines = renderTable(
      [
        { name: chalk.red('a'), count: '1' },
        { name: 'bbb', count: '2' },
      ],
      columns
    ).map(stripAnsi);

    assert.equal(lines[1], 'a     1');
    assert.equal(lines[2], 'bbb   2');
  });

  it('trims trailing padding from the last column', () => {
    const lines = renderTable(
      [
        { name: 'a', count: '1' },
        { name: 'b', count: '22' },
      ],
      columns
    ).map(stripAnsi);

    assert.equal(lines[1], 'a     1');
  });

  it('renders a header even when there are no rows', () => {
    assert.deepEqual(renderTable([], columns).map(stripAnsi), ['Name  Count']);
  });

  it('prints a note beneath the row it belongs to', () => {
    const rows: Row[] = [
      { name: 'a', count: '1', note: 'went wrong' },
      { name: 'b', count: '2' },
    ];

    const lines = renderTable(rows, columns, { note: (row) => row.note }).map(stripAnsi);

    assert.deepEqual(lines, ['Name  Count', 'a     1', '    went wrong', 'b     2']);
  });

  it('skips empty notes', () => {
    const lines = renderTable([{ name: 'a', count: '1', note: '' }], columns, { note: (row) => row.note });

    assert.equal(lines.length, 2);
  });
});
