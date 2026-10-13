import assert from 'node:assert/strict';
import chalk from 'chalk';
import { formatLevel, formatLogHeader, parseLogEntries, parseLogLines } from '../../src/shared/apexLogRender.js';

const stripAnsi = (value: string): string => value.replace(/\[[0-9;]*m/g, '');

describe('apex log renderers', () => {
  describe('parseLogEntries', () => {
    it('reads a USER_DEBUG line into a debug entry with line number, level and message', () => {
      const entries = parseLogEntries('10:15:30.1 (1234)|USER_DEBUG|[12]|DEBUG|hello world');

      assert.deepEqual(entries, [{ kind: 'debug', line: 12, level: 'DEBUG', message: 'hello world' }]);
    });

    it('keeps pipes that appear inside the debug message', () => {
      const [entry] = parseLogEntries('x|USER_DEBUG|[1]|WARN|a|b|c');

      assert.deepEqual(entry, { kind: 'debug', line: 1, level: 'WARN', message: 'a|b|c' });
    });

    it('ignores other events and malformed USER_DEBUG lines', () => {
      const body = [
        '45.0 APEX_CODE,DEBUG',
        'x|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous',
        'x|USER_DEBUG|[1]',
        'x|USER_DEBUG|[2]|DEBUG|kept',
        '',
      ].join('\n');

      assert.deepEqual(parseLogEntries(body), [{ kind: 'debug', line: 2, level: 'DEBUG', message: 'kept' }]);
    });

    it('reads EXCEPTION_THROWN and FATAL_ERROR lines into exception entries, in log order', () => {
      const body = [
        'x|USER_DEBUG|[4]|DEBUG|before',
        'x|EXCEPTION_THROWN|[5]|System.NullPointerException: boom',
        'x|FATAL_ERROR|System.LimitException: too many SOQL',
      ].join('\n');

      assert.deepEqual(parseLogEntries(body), [
        { kind: 'debug', line: 4, level: 'DEBUG', message: 'before' },
        { kind: 'exception', message: '[5]|System.NullPointerException: boom' },
        { kind: 'exception', message: 'System.LimitException: too many SOQL' },
      ]);
    });
  });

  describe('parseLogLines', () => {
    it('renders the exact coloured terminal output for debug and exception lines', () => {
      const previousLevel = chalk.level;
      chalk.level = 1;

      try {
        const body = [
          'h|USER_DEBUG|[12]|ERROR|a|b',
          'h|USER_DEBUG|[3]|INFO|x',
          'h|EXCEPTION_THROWN|[5]|boom',
          'h|FATAL_ERROR|dead',
        ].join('\n');

        // Captured from the renderer before it was split into parseLogEntries + formatter.
        assert.deepEqual(parseLogLines(body), [
          '  \u001b[2m[12] \u001b[22m \u001b[31m\u001b[1mERROR  \u001b[22m\u001b[39m  a|b',
          '  \u001b[2m[3]  \u001b[22m \u001b[36mINFO   \u001b[39m  x',
          '\u001b[31m  ⚠  [5]|boom\u001b[39m',
          '\u001b[31m  ⚠  dead\u001b[39m',
        ]);
      } finally {
        chalk.level = previousLevel;
      }
    });

    it('renders a USER_DEBUG line with line number, level, and message', () => {
      const body = '10:15:30.1 (1234)|USER_DEBUG|[12]|DEBUG|hello world';

      const lines = parseLogLines(body);

      assert.equal(lines.length, 1);
      assert.equal(stripAnsi(lines[0]), '  [12]  DEBUG    hello world');
    });

    it('keeps pipes that appear inside the debug message', () => {
      const lines = parseLogLines('x|USER_DEBUG|[1]|DEBUG|a|b|c');

      assert.equal(stripAnsi(lines[0]).endsWith('a|b|c'), true);
    });

    it('ignores lines that are not debug or error events', () => {
      const body = ['x|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous', 'x|METHOD_ENTRY|[1]|Foo.bar()'].join('\n');

      assert.deepEqual(parseLogLines(body), []);
    });

    it('skips malformed USER_DEBUG lines with too few segments', () => {
      assert.deepEqual(parseLogLines('x|USER_DEBUG|[1]'), []);
    });

    it('applies the filter to the message only', () => {
      const body = ['x|USER_DEBUG|[1]|DEBUG|keep me', 'x|USER_DEBUG|[2]|DEBUG|drop me'].join('\n');

      const lines = parseLogLines(body, 'keep');

      assert.equal(lines.length, 1);
      assert.equal(stripAnsi(lines[0]).endsWith('keep me'), true);
    });

    it('renders EXCEPTION_THROWN and FATAL_ERROR lines with a warning marker', () => {
      const body = [
        'x|EXCEPTION_THROWN|[5]|System.NullPointerException: boom',
        'x|FATAL_ERROR|System.LimitException: too many SOQL',
      ].join('\n');

      const lines = parseLogLines(body);

      assert.equal(lines.length, 2);
      assert.equal(stripAnsi(lines[0]), '  ⚠  [5]|System.NullPointerException: boom');
      assert.equal(stripAnsi(lines[1]), '  ⚠  System.LimitException: too many SOQL');
    });

    it('does not filter out exception lines', () => {
      const lines = parseLogLines('x|FATAL_ERROR|boom', 'nomatch');

      assert.equal(lines.length, 1);
    });
  });

  describe('formatLevel', () => {
    it('pads every level to a fixed width', () => {
      for (const level of ['ERROR', 'WARN', 'INFO', 'FINEST', 'DEBUG']) {
        assert.equal(stripAnsi(formatLevel(level)).length, 7);
      }
    });

    it('colors ERROR red and WARN yellow', () => {
      assert.equal(formatLevel('ERROR'), chalk.red.bold('ERROR  '));
      assert.equal(formatLevel('WARN'), chalk.yellow('WARN   '));
    });

    it('dims unknown levels the same way it dims DEBUG', () => {
      assert.equal(formatLevel('OTHER'), chalk.dim('OTHER  '));
      assert.equal(formatLevel('DEBUG'), chalk.dim('DEBUG  '));
    });
  });

  describe('formatLogHeader', () => {
    it('includes the operation, time, and duration', () => {
      const header = stripAnsi(formatLogHeader('ApexTestHandler', '2026-07-19T10:15:30.000Z', 123, 'Success'));

      assert.equal(header.includes('ApexTestHandler'), true);
      assert.equal(header.includes('123ms'), true);
    });

    it('falls back to a generic label and omits duration when unknown', () => {
      const header = stripAnsi(formatLogHeader(undefined, '2026-07-19T10:15:30.000Z', undefined, undefined));

      assert.equal(header.includes('Log'), true);
      assert.equal(header.includes('ms'), false);
    });

    it('flags a non-success status', () => {
      const header = stripAnsi(formatLogHeader('Api', '2026-07-19T10:15:30.000Z', 5, 'Failed'));

      assert.equal(header.includes('[Failed]'), true);
    });
  });
});
