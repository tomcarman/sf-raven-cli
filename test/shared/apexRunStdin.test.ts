import assert from 'node:assert/strict';
import type { ApexRunResult } from '../../src/shared/apexRun.js';
import {
  apexRunFlagError,
  parseStdinRunRequest,
  serveApexStdin,
  type ApexStdinEvent,
} from '../../src/shared/apexRunStdin.js';

const resultFor = (code: string): ApexRunResult => ({
  success: true,
  compiled: true,
  logLines: [code],
  log: `USER_DEBUG|${code}`,
  entries: [],
  duration: 5,
});

/** Lines pushed by the test, ended with close(), like stdin read through readline. */
const createInput = (): { lines: AsyncIterable<string>; push: (line: string) => void; close: () => void } => {
  const queued: string[] = [];
  let closed = false;
  let wake: (() => void) | undefined;

  const notify = (): void => {
    wake?.();
    wake = undefined;
  };

  return {
    lines: {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        while (true) {
          const next = queued.shift();
          if (next !== undefined) {
            yield next;
          } else if (closed) {
            return;
          } else {
            // eslint-disable-next-line no-await-in-loop
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
      },
    },
    push: (line): void => {
      queued.push(line);
      notify();
    },
    close: (): void => {
      closed = true;
      notify();
    },
  };
};

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Deferred = { code: string; resolve: () => void; reject: (error: Error) => void };

/** An executor whose runs finish only when the test says so. */
const createExecutor = (): {
  execute: (code: string) => Promise<ApexRunResult>;
  pending: Deferred[];
  started: string[];
} => {
  const pending: Deferred[] = [];
  const started: string[] = [];
  return {
    pending,
    started,
    execute: (code): Promise<ApexRunResult> =>
      new Promise((resolve, reject) => {
        started.push(code);
        pending.push({ code, resolve: () => resolve(resultFor(code)), reject });
      }),
  };
};

const request = (id: string, code: string): string => JSON.stringify({ id, code });

describe('apex run --stdin', () => {
  describe('apexRunFlagError', () => {
    const flags = { watch: false, ndjson: false, stdin: false, json: false, fileSet: false };

    it('accepts the existing modes and --stdin --ndjson', () => {
      assert.equal(apexRunFlagError(flags), undefined);
      assert.equal(apexRunFlagError({ ...flags, json: true, fileSet: true }), undefined);
      assert.equal(apexRunFlagError({ ...flags, watch: true }), undefined);
      assert.equal(apexRunFlagError({ ...flags, watch: true, ndjson: true, fileSet: true }), undefined);
      assert.equal(apexRunFlagError({ ...flags, stdin: true, ndjson: true }), undefined);
    });

    it('keeps the existing watch and ndjson rules', () => {
      assert.equal(apexRunFlagError({ ...flags, watch: true, json: true }), 'error.watchWithJson');
      assert.equal(apexRunFlagError({ ...flags, ndjson: true }), 'error.ndjsonRequiresWatch');
    });

    it('requires --ndjson with --stdin, and rejects --file, --watch and --json', () => {
      assert.equal(apexRunFlagError({ ...flags, stdin: true }), 'error.stdinRequiresNdjson');
      for (const other of ['fileSet', 'watch', 'json'] as const) {
        assert.equal(apexRunFlagError({ ...flags, stdin: true, ndjson: true, [other]: true }), 'error.stdinExclusive');
      }
    });
  });

  describe('parseStdinRunRequest', () => {
    it('reads an id and code', () => {
      assert.deepEqual(parseStdinRunRequest('{"id":"a1","code":"System.debug(1);"}'), {
        id: 'a1',
        code: 'System.debug(1);',
      });
    });

    it('rejects lines that are not a run request', () => {
      for (const line of ['not json', '[]', 'null', '{"code":"x"}', '{"id":"","code":"x"}', '{"id":"a","code":5}']) {
        const parsed = parseStdinRunRequest(line);
        assert.ok('error' in parsed, line);
      }
    });
  });

  describe('serveApexStdin', () => {
    it('sends ready once, before any run, and runs nothing at startup', async () => {
      const input = createInput();
      const executor = createExecutor();
      const events: ApexStdinEvent[] = [];
      const served = serveApexStdin({ lines: input.lines, execute: executor.execute, write: (e) => events.push(e) });

      await settle();
      assert.deepEqual(events, [{ type: 'ready' }]);
      assert.deepEqual(executor.started, []);

      input.push(request('r1', 'one'));
      await settle();
      executor.pending[0].resolve();
      input.close();
      await served;

      assert.equal(events.filter((e) => e.type === 'ready').length, 1);
      assert.deepEqual(events[0], { type: 'ready' });
    });

    it('answers each request with run-start and a run event carrying its id and the full result', async () => {
      const input = createInput();
      const executor = createExecutor();
      const events: ApexStdinEvent[] = [];
      const served = serveApexStdin({ lines: input.lines, execute: executor.execute, write: (e) => events.push(e) });

      input.push(request('r1', 'one'));
      await settle();
      executor.pending[0].resolve();
      input.close();
      await served;

      assert.deepEqual(events, [
        { type: 'ready' },
        { type: 'run-start', id: 'r1' },
        { type: 'run', id: 'r1', ...resultFor('one') },
      ]);
    });

    it('runs queued requests one at a time, in the order received', async () => {
      const input = createInput();
      const executor = createExecutor();
      const events: ApexStdinEvent[] = [];
      const served = serveApexStdin({ lines: input.lines, execute: executor.execute, write: (e) => events.push(e) });

      input.push(request('r1', 'one'));
      input.push(request('r2', 'two'));
      await settle();
      assert.deepEqual(executor.started, ['one']);

      executor.pending[0].resolve();
      await settle();
      assert.deepEqual(executor.started, ['one', 'two']);

      executor.pending[1].resolve();
      input.close();
      await served;

      assert.deepEqual(
        events.map((e) => [e.type, 'id' in e ? e.id : undefined]),
        [
          ['ready', undefined],
          ['run-start', 'r1'],
          ['run', 'r1'],
          ['run-start', 'r2'],
          ['run', 'r2'],
        ]
      );
    });

    it('answers a failed run with an error carrying its id, and keeps going', async () => {
      const input = createInput();
      const executor = createExecutor();
      const events: ApexStdinEvent[] = [];
      const served = serveApexStdin({ lines: input.lines, execute: executor.execute, write: (e) => events.push(e) });

      input.push(request('r1', 'one'));
      input.push(request('r2', 'two'));
      await settle();
      executor.pending[0].reject(new Error('INVALID_SESSION_ID'));
      await settle();
      executor.pending[1].resolve();
      input.close();
      await served;

      assert.deepEqual(events.slice(1, 3), [
        { type: 'run-start', id: 'r1' },
        { type: 'error', id: 'r1', message: 'INVALID_SESSION_ID' },
      ]);
      assert.deepEqual(events[4], { type: 'run', id: 'r2', ...resultFor('two') });
    });

    it('answers a bad line with an error without an id, then runs the next line', async () => {
      const input = createInput();
      const executor = createExecutor();
      const events: ApexStdinEvent[] = [];
      const served = serveApexStdin({ lines: input.lines, execute: executor.execute, write: (e) => events.push(e) });

      input.push('{"code": "no id"}');
      input.push(request('r2', 'two'));
      await settle();
      executor.pending[0].resolve();
      input.close();
      await served;

      assert.equal(events[1].type, 'error');
      assert.equal('id' in events[1], false);
      assert.deepEqual(executor.started, ['two']);
      assert.deepEqual(events[3], { type: 'run', id: 'r2', ...resultFor('two') });
    });

    it('ignores blank lines', async () => {
      const input = createInput();
      const executor = createExecutor();
      const events: ApexStdinEvent[] = [];
      const served = serveApexStdin({ lines: input.lines, execute: executor.execute, write: (e) => events.push(e) });

      input.push('');
      input.push('   ');
      input.close();
      await served;

      assert.deepEqual(events, [{ type: 'ready' }]);
    });

    it('finishes once stdin closes, after the run in progress', async () => {
      const input = createInput();
      const executor = createExecutor();
      const events: ApexStdinEvent[] = [];
      let finished = false;
      const served = serveApexStdin({
        lines: input.lines,
        execute: executor.execute,
        write: (e) => events.push(e),
      }).then(() => {
        finished = true;
      });

      input.push(request('r1', 'one'));
      await settle();
      input.close();
      await settle();
      assert.equal(finished, false);

      executor.pending[0].resolve();
      await served;
      assert.equal(finished, true);
      assert.equal(events.at(-1)?.type, 'run');
    });
  });
});
