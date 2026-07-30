import assert from 'node:assert/strict';
import type { ExecuteAnonymousResponse } from '@salesforce/apex-node';
import {
  buildApexRunErrorEvent,
  buildApexRunEvent,
  buildApexRunResult,
  buildApexRunStatusEvent,
  renderApexRun,
  serializeApexRunEvent,
} from '../../src/shared/apexRun.js';
import { stripAnsi } from '../../src/shared/table.js';

const debugLog = ['10:00:00.1 (1)|USER_DEBUG|[3]|DEBUG|hello', '10:00:00.2 (2)|USER_DEBUG|[4]|DEBUG|goodbye'].join(
  '\n'
);

describe('apex run result', () => {
  describe('buildApexRunResult', () => {
    it('reports a successful run with its plain-text debug lines and duration', () => {
      const response: ExecuteAnonymousResponse = { compiled: true, success: true, logs: debugLog };

      const result = buildApexRunResult(response, 412);

      assert.equal(result.success, true);
      assert.equal(result.compiled, true);
      assert.equal(result.duration, 412);
      assert.equal(result.logLines.length, 2);
      assert.equal(result.compileProblem, undefined);
      assert.equal(result.exceptionMessage, undefined);
    });

    it('strips colour codes from logLines so JSON output stays plain', () => {
      const result = buildApexRunResult({ compiled: true, success: true, logs: debugLog }, 1);

      for (const line of result.logLines) {
        assert.equal(line, stripAnsi(line));
      }

      assert.equal(result.logLines[0].trim(), '[3]   DEBUG    hello');
    });

    it('applies the filter to the captured debug lines', () => {
      const result = buildApexRunResult({ compiled: true, success: true, logs: debugLog }, 1, 'good');

      assert.equal(result.logLines.length, 1);
      assert.equal(result.logLines[0].endsWith('goodbye'), true);
    });

    it('tolerates a response with no log body', () => {
      const result = buildApexRunResult({ compiled: true, success: true }, 1);

      assert.deepEqual(result.logLines, []);
    });

    it('reports a compile problem with its line and column', () => {
      const result = buildApexRunResult(
        {
          compiled: false,
          success: false,
          diagnostic: [
            {
              lineNumber: 3,
              columnNumber: 12,
              compileProblem: 'Variable does not exist: foo',
              exceptionMessage: '',
              exceptionStackTrace: '',
            },
          ],
        },
        5
      );

      assert.equal(result.compileProblem, 'Variable does not exist: foo (line 3, column 12)');
      assert.equal(result.exceptionMessage, undefined);
    });

    it('omits the position when the diagnostic has no line number', () => {
      const result = buildApexRunResult(
        {
          compiled: false,
          success: false,
          diagnostic: [{ compileProblem: 'Unexpected token', exceptionMessage: '', exceptionStackTrace: '' }],
        },
        5
      );

      assert.equal(result.compileProblem, 'Unexpected token');
    });

    it('reports a runtime exception with its stack trace once the code compiled', () => {
      const result = buildApexRunResult(
        {
          compiled: true,
          success: false,
          logs: debugLog,
          diagnostic: [
            {
              compileProblem: '',
              exceptionMessage: 'System.NullPointerException: Attempt to de-reference a null object',
              exceptionStackTrace: 'AnonymousBlock: line 4, column 1',
            },
          ],
        },
        7
      );

      assert.equal(result.exceptionMessage, 'System.NullPointerException: Attempt to de-reference a null object');
      assert.equal(result.exceptionStackTrace, 'AnonymousBlock: line 4, column 1');
      assert.equal(result.compileProblem, undefined);
      assert.equal(result.logLines.length, 2, 'debug lines emitted before the exception are kept');
    });
  });

  describe('NDJSON events', () => {
    it('builds the watching and run-start status events with the watched file', () => {
      assert.deepEqual(buildApexRunStatusEvent('watching', '/tmp/scratch.apex'), {
        type: 'status',
        status: 'watching',
        file: '/tmp/scratch.apex',
      });

      assert.deepEqual(buildApexRunStatusEvent('run-start', '/tmp/scratch.apex'), {
        type: 'status',
        status: 'run-start',
        file: '/tmp/scratch.apex',
      });
    });

    it('carries the single-shot result fields on the run event', () => {
      const result = buildApexRunResult({ compiled: true, success: true, logs: debugLog }, 42);

      const event = buildApexRunEvent(result);

      assert.equal(event.type, 'run');
      assert.equal(event.success, true);
      assert.equal(event.duration, 42);
      assert.deepEqual(event.logLines, result.logLines);
    });

    it('builds an error event', () => {
      assert.deepEqual(buildApexRunErrorEvent('boom'), { type: 'error', message: 'boom' });
    });

    it('serializes each event onto a single line', () => {
      const result = buildApexRunResult(
        {
          compiled: true,
          success: false,
          logs: debugLog,
          diagnostic: [{ compileProblem: '', exceptionMessage: 'boom', exceptionStackTrace: 'line 1\nline 2' }],
        },
        42
      );

      const line = serializeApexRunEvent(buildApexRunEvent(result));

      assert.equal(line.includes('\n'), false);
      assert.deepEqual(JSON.parse(line), { type: 'run', ...result });
    });
  });

  describe('renderApexRun', () => {
    const startedAt = '2026-07-28T10:00:00.000Z';

    it('prints a header with the duration followed by the debug lines', () => {
      const result = buildApexRunResult({ compiled: true, success: true, logs: debugLog }, 412);

      const output = renderApexRun(result, debugLog, { startedAt }).map(stripAnsi);

      assert.equal(output[0].includes('Execute Anonymous'), true);
      assert.equal(output[0].includes('412ms'), true);
      assert.equal(output[1].trim(), '[3]   DEBUG    hello');
      assert.equal(output[2].trim(), '[4]   DEBUG    goodbye');
    });

    it('marks the header failed when the run did not succeed', () => {
      const result = buildApexRunResult({ compiled: true, success: false, logs: '' }, 1);

      const output = renderApexRun(result, '', { startedAt }).map(stripAnsi);

      assert.equal(output[0].includes('[Failed]'), true);
    });

    it('dumps the whole log body under raw instead of the parsed lines', () => {
      const result = buildApexRunResult({ compiled: true, success: true, logs: debugLog }, 1);

      const output = renderApexRun(result, debugLog, { startedAt, raw: true });

      assert.equal(output[1], debugLog);
    });

    it('honours the filter when rendering debug lines', () => {
      const result = buildApexRunResult({ compiled: true, success: true, logs: debugLog }, 1, 'good');

      const output = renderApexRun(result, debugLog, { startedAt, filter: 'good' }).map(stripAnsi);

      assert.equal(output.filter((line) => line.includes('hello')).length, 0);
      assert.equal(output.filter((line) => line.includes('goodbye')).length, 1);
    });

    it('prints the compile error', () => {
      const result = buildApexRunResult(
        {
          compiled: false,
          success: false,
          diagnostic: [
            { lineNumber: 3, columnNumber: 12, compileProblem: 'bad', exceptionMessage: '', exceptionStackTrace: '' },
          ],
        },
        5
      );

      const output = renderApexRun(result, '', { startedAt }).map(stripAnsi);

      assert.equal(
        output.some((line) => line.includes('Compile error: bad (line 3, column 12)')),
        true
      );
    });

    it('prints the exception once, preferring the diagnostic over the log body copy', () => {
      const logs = ['x|USER_DEBUG|[1]|DEBUG|before', 'x|FATAL_ERROR|System.LimitException: boom'].join('\n');
      const result = buildApexRunResult(
        {
          compiled: true,
          success: false,
          logs,
          diagnostic: [
            { compileProblem: '', exceptionMessage: 'System.LimitException: boom', exceptionStackTrace: 'line 1' },
          ],
        },
        5
      );

      const output = renderApexRun(result, logs, { startedAt }).map(stripAnsi);

      assert.equal(output.filter((line) => line.includes('System.LimitException: boom')).length, 1);
      assert.equal(
        output.some((line) => line.includes('before')),
        true
      );
    });

    it('prints each stack trace frame beneath the exception message', () => {
      const result = buildApexRunResult(
        {
          compiled: true,
          success: false,
          diagnostic: [
            {
              compileProblem: '',
              exceptionMessage: 'System.LimitException: boom',
              exceptionStackTrace: 'AnonymousBlock: line 1\nClass.Foo.bar: line 9',
            },
          ],
        },
        5
      );

      const output = renderApexRun(result, '', { startedAt }).map(stripAnsi);

      assert.equal(
        output.some((line) => line.includes('System.LimitException: boom')),
        true
      );
      assert.equal(
        output.filter((line) => line.trim().startsWith('AnonymousBlock') || line.trim().startsWith('Class.Foo')).length,
        2
      );
    });
  });
});
