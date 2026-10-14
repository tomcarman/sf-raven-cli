import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ExecuteService } from '@salesforce/apex-node';
import type { Connection } from '@salesforce/core';
import {
  APEX_LOG_CATEGORIES,
  APEX_LOG_DETAILS,
  buildExecuteAnonymousEnvelope,
  DEFAULT_APEX_LOG_DETAIL,
  executeAnonymousAtDetail,
  executeAnonymousWithCategories,
  isApexLogDetail,
  parseExecuteAnonymousResponse,
  type ApexSoapConnection,
} from '../../src/shared/apexLogDetail.js';
import RavenApexRun from '../../src/commands/raven/apex/run.js';
import { buildApexRunResult } from '../../src/shared/apexRun.js';
import { parseApexStdinRunRequest, serveApexStdin, type ApexStdinEvent } from '../../src/shared/apexRunStdin.js';

const TOKEN = '00D000000000001!AQ0AQSecretTokenValue';
const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/apex-logs/${name}.log`, import.meta.url), 'utf8');

const nil = { $: { 'xsi:nil': 'true' } };

type ResultFields = Record<string, unknown>;

/** A SOAP response as jsforce hands it over after xml2js parsing. */
const soapResponse = (result: ResultFields, log?: string): unknown => ({
  'soapenv:Envelope': {
    ...(log == null ? {} : { 'soapenv:Header': { DebuggingInfo: { debugLog: log } } }),
    'soapenv:Body': { executeAnonymousResponse: { result } },
  },
});

const success: ResultFields = {
  column: '-1',
  compileProblem: nil,
  compiled: 'true',
  exceptionMessage: nil,
  exceptionStackTrace: nil,
  line: '-1',
  success: 'true',
};

const compileError: ResultFields = {
  column: '12',
  compileProblem: 'Variable does not exist: foo',
  compiled: 'false',
  exceptionMessage: nil,
  exceptionStackTrace: nil,
  line: '3',
  success: 'false',
};

const runtimeError: ResultFields = {
  column: '1',
  compileProblem: nil,
  compiled: 'true',
  exceptionMessage: 'System.MathException: Divide by 0',
  exceptionStackTrace: 'AnonymousBlock: line 1, column 1',
  line: '1',
  success: 'false',
};

type SentRequest = { method: string; url: string; body?: string; headers?: Record<string, string> };

/** A connection that records requests and answers them in turn. */
const fakeConnection = (
  answers: Array<(request: SentRequest) => unknown>
): ApexSoapConnection & { sent: SentRequest[] } => {
  const sent: SentRequest[] = [];
  return {
    sent,
    accessToken: TOKEN,
    instanceUrl: 'https://example.my.salesforce.com',
    version: '64.0',
    baseUrl: () => 'https://example.my.salesforce.com/services/data/v64.0',
    request: <T>(request: SentRequest): Promise<T> => {
      sent.push(request);
      const answer = answers.shift();
      if (answer == null) return Promise.reject(new Error('unexpected request'));
      try {
        return Promise.resolve(answer(request) as T);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
};

const httpError = (name: string, message: string): Error => Object.assign(new Error(message), { name });

/** What apex-node's own path makes of the same parsed SOAP response. */
const viaApexNode = (response: unknown): ReturnType<typeof buildApexRunResult> =>
  buildApexRunResult(
    new ExecuteService({} as Connection).jsonFormat(response as Parameters<ExecuteService['jsonFormat']>[0]),
    7
  );

describe('apex run --log-detail', () => {
  describe('levels', () => {
    it('offers debug, fine and finest with debug as the default', () => {
      assert.deepEqual(APEX_LOG_DETAILS, ['debug', 'fine', 'finest']);
      assert.equal(DEFAULT_APEX_LOG_DETAIL, 'debug');
      assert.equal(isApexLogDetail('fine'), true);
      for (const value of ['FINE', 'info', '', 3, null, undefined]) {
        assert.equal(isApexLogDetail(value), false, String(value));
      }
    });

    it('is a --log-detail option flag on apex run, defaulting to debug', () => {
      const flag = RavenApexRun.flags['log-detail'];

      assert.equal(flag.type, 'option');
      assert.deepEqual(flag.options, ['debug', 'fine', 'finest']);
      assert.equal(flag.default, 'debug');
    });
  });

  describe('buildExecuteAnonymousEnvelope', () => {
    const categoriesIn = (envelope: string): string[] =>
      [...envelope.matchAll(/<apex:category>(\w+)<\/apex:category><apex:level>(\w+)<\/apex:level>/g)].map(
        ([, category, level]) => `${category}=${level}`
      );

    it('sends the fine categories instead of a debugLevel', () => {
      const envelope = buildExecuteAnonymousEnvelope(TOKEN, 'x', APEX_LOG_CATEGORIES.fine);

      assert.deepEqual(categoriesIn(envelope), [
        'Apex_code=Fine',
        'Apex_profiling=Info',
        'Db=Info',
        'System=Debug',
        'Callout=Info',
        'Validation=Info',
        'Workflow=Info',
      ]);
      assert.equal(envelope.includes('debugLevel'), false);
    });

    it('sends the finest categories', () => {
      const envelope = buildExecuteAnonymousEnvelope(TOKEN, 'x', APEX_LOG_CATEGORIES.finest);

      assert.deepEqual(categoriesIn(envelope), [
        'Apex_code=Finest',
        'Apex_profiling=Finest',
        'Db=Finest',
        'System=Finest',
        'Callout=Info',
        'Validation=Info',
        'Workflow=Info',
      ]);
    });

    it('XML-escapes the code', () => {
      const envelope = buildExecuteAnonymousEnvelope(TOKEN, `if (1 < 2 && "a" != 'b') {}`, APEX_LOG_CATEGORIES.fine);

      assert.match(envelope, /<apexcode>if \(1 &lt; 2 &amp;&amp; &quot;a&quot; != &apos;b&apos;\) \{\}<\/apexcode>/);
    });

    it('matches the apex-node envelope apart from the DebuggingHeader', async () => {
      const code = `System.debug('<a & b>');`;
      const apexNodeConnection = fakeConnection([() => soapResponse(success, '')]);
      await new ExecuteService(apexNodeConnection as unknown as Connection).executeAnonymous({ apexCode: code });
      const ours = buildExecuteAnonymousEnvelope(TOKEN, code, APEX_LOG_CATEGORIES.fine);
      const withoutDebugHeader = (envelope: string): string =>
        envelope.replace(/<apex:DebuggingHeader>.*<\/apex:DebuggingHeader>/, '');

      assert.equal(withoutDebugHeader(ours), withoutDebugHeader(apexNodeConnection.sent[0].body ?? ''));
    });
  });

  describe('parseExecuteAnonymousResponse', () => {
    it('reads a successful run and its log into the same result as apex-node', () => {
      const response = soapResponse(success, fixture('fine'));
      const result = buildApexRunResult(parseExecuteAnonymousResponse(response), 7);

      assert.deepEqual(result, viaApexNode(response));
      assert.equal(result.success, true);
      assert.equal(result.log, fixture('fine'));
      assert.deepEqual(result.entries, [{ kind: 'debug', line: 2, level: 'DEBUG', message: 'raven 1 6' }]);
    });

    it('reads a compile error with its line and column', () => {
      const response = soapResponse(compileError, '');
      const result = buildApexRunResult(parseExecuteAnonymousResponse(response), 7);

      assert.deepEqual(result, viaApexNode(response));
      assert.equal(result.compiled, false);
      assert.equal(result.compileProblem, 'Variable does not exist: foo (line 3, column 12)');
    });

    it('reads a runtime exception with its message and stack trace', () => {
      const response = soapResponse(runtimeError, '');
      const result = buildApexRunResult(parseExecuteAnonymousResponse(response), 7);

      assert.deepEqual(result, viaApexNode(response));
      assert.equal(result.exceptionMessage, 'System.MathException: Divide by 0');
      assert.equal(result.exceptionStackTrace, 'AnonymousBlock: line 1, column 1');
    });

    it('tolerates a response without a debugging header', () => {
      const result = buildApexRunResult(parseExecuteAnonymousResponse(soapResponse(success)), 7);

      assert.equal(result.log, '');
      assert.deepEqual(result.entries, []);
    });

    it('rejects a response without a result', () => {
      assert.throws(() => parseExecuteAnonymousResponse({ 'soapenv:Envelope': {} }), /without a result/);
    });
  });

  describe('executeAnonymousWithCategories', () => {
    it('posts the envelope to the SOAP Apex endpoint', async () => {
      const connection = fakeConnection([() => soapResponse(success, 'log body')]);

      const response = await executeAnonymousWithCategories(connection, 'x', APEX_LOG_CATEGORIES.finest);

      assert.deepEqual(response, { compiled: true, success: true, logs: 'log body' });
      const [sent] = connection.sent;
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, 'https://example.my.salesforce.com/services/Soap/s/64.0/00D000000000001');
      assert.deepEqual(sent.headers, { 'content-type': 'text/xml', soapaction: 'executeAnonymous' });
      assert.equal(sent.body, buildExecuteAnonymousEnvelope(TOKEN, 'x', APEX_LOG_CATEGORIES.finest));
    });

    it('refreshes the session once and retries when the session is invalid', async () => {
      const connection = fakeConnection([
        () => {
          throw httpError('ERROR_HTTP_500', 'INVALID_SESSION_ID: Invalid Session ID found in SessionHeader');
        },
        () => ({}),
        () => soapResponse(success, 'log body'),
      ]);

      const response = await executeAnonymousWithCategories(connection, 'x', APEX_LOG_CATEGORIES.fine);

      assert.equal(response.success, true);
      assert.deepEqual(
        connection.sent.map((sent) => sent.method),
        ['POST', 'GET', 'POST']
      );
      assert.equal(connection.sent[1].url, connection.baseUrl());
    });

    it('gives up after a second invalid session', async () => {
      const invalid = (): never => {
        throw httpError('ERROR_HTTP_500', 'INVALID_SESSION_ID');
      };
      const connection = fakeConnection([invalid, () => ({}), invalid, () => ({})]);

      await assert.rejects(
        executeAnonymousWithCategories(connection, 'x', APEX_LOG_CATEGORIES.fine),
        /authentication for execute anonymous failed/
      );
    });

    it('never puts the access token in an error message', async () => {
      const connection = fakeConnection([
        (request) => {
          throw httpError('ERROR_HTTP_500', `Fault for ${request.body ?? ''} with ${TOKEN}`);
        },
      ]);

      await assert.rejects(
        executeAnonymousWithCategories(connection, 'x', APEX_LOG_CATEGORIES.fine),
        (error: Error) => {
          assert.match(error.message, /^Unexpected error while executing anonymous apex\./);
          assert.equal(error.message.includes(TOKEN), false);
          assert.equal(error.message.includes('[redacted]'), true);
          return true;
        }
      );
    });

    it('redacts a token that changed during a retry as well', async () => {
      const connection = fakeConnection([
        () => {
          throw httpError('ERROR_HTTP_500', 'INVALID_SESSION_ID');
        },
        () => {
          connection.accessToken = 'NEW!token';
          return {};
        },
        () => {
          throw new Error(`bad request for ${TOKEN} and NEW!token`);
        },
      ]);

      await assert.rejects(
        executeAnonymousWithCategories(connection, 'x', APEX_LOG_CATEGORIES.fine),
        (error: Error) => {
          assert.equal(error.message.includes(TOKEN), false);
          assert.equal(error.message.includes('NEW!token'), false);
          return true;
        }
      );
    });
  });

  describe('executeAnonymousAtDetail', () => {
    it('sends debug through apex-node, untouched', async () => {
      const connection = fakeConnection([]);
      const calls: string[] = [];

      const response = await executeAnonymousAtDetail(connection, 'x', 'debug', (code) => {
        calls.push(code);
        return Promise.resolve({ compiled: true, success: true, logs: 'apex-node' });
      });

      assert.deepEqual(calls, ['x']);
      assert.deepEqual(connection.sent, []);
      assert.equal(response.logs, 'apex-node');
    });

    for (const detail of ['fine', 'finest'] as const) {
      it(`sends ${detail} through the plugin's own SOAP call`, async () => {
        const connection = fakeConnection([() => soapResponse(success, 'own')]);

        const response = await executeAnonymousAtDetail(connection, 'x', detail, () =>
          Promise.reject(new Error('apex-node should not run'))
        );

        assert.equal(response.logs, 'own');
        assert.equal(connection.sent[0].body, buildExecuteAnonymousEnvelope(TOKEN, 'x', APEX_LOG_CATEGORIES[detail]));
      });
    }
  });

  describe('fixtures from a real org', () => {
    it('logs SOQL from fine up, and only debug lines and limits at debug', () => {
      const has = (name: string, event: string): boolean => fixture(name).includes(`|${event}|`);

      assert.equal(has('debug', 'SOQL_EXECUTE_BEGIN'), false);
      assert.equal(has('fine', 'SOQL_EXECUTE_BEGIN'), true);
      assert.equal(has('finest', 'SOQL_EXECUTE_BEGIN'), true);
      assert.equal(has('finest', 'STATEMENT_EXECUTE'), true);
      for (const name of ['debug', 'fine', 'finest']) {
        assert.equal(has(name, 'USER_DEBUG'), true, name);
        assert.equal(has(name, 'LIMIT_USAGE_FOR_NS'), true, name);
      }
    });
  });

  describe('--stdin logDetail', () => {
    it('reads an optional logDetail', () => {
      assert.deepEqual(parseApexStdinRunRequest('{"id":"a","code":"x"}'), { id: 'a', code: 'x' });
      assert.deepEqual(parseApexStdinRunRequest('{"id":"a","code":"x","logDetail":"finest"}'), {
        id: 'a',
        code: 'x',
        logDetail: 'finest',
      });
    });

    it('rejects an invalid logDetail with the request id', () => {
      for (const logDetail of ['FINE', 'info', '', 3, null]) {
        const parsed = parseApexStdinRunRequest(JSON.stringify({ id: 'a', code: 'x', logDetail }));
        assert.ok('error' in parsed, String(logDetail));
        assert.equal(parsed.id, 'a');
        assert.match(parsed.error, /logDetail/);
      }
    });

    it('passes the request logDetail to the run and answers a bad one with an id error, then keeps going', async () => {
      const lines = [
        JSON.stringify({ id: 'r1', code: 'one', logDetail: 'fine' }),
        JSON.stringify({ id: 'r2', code: 'two', logDetail: 'loud' }),
        JSON.stringify({ id: 'r3', code: 'three' }),
      ];
      const runs: Array<[string, string | undefined]> = [];
      const events: ApexStdinEvent[] = [];

      await serveApexStdin({
        lines: (async function* (): AsyncGenerator<string> {
          yield* lines;
        })(),
        execute: (code, logDetail) => {
          runs.push([code, logDetail]);
          return Promise.resolve({ success: true, compiled: true, logLines: [], log: '', entries: [], duration: 1 });
        },
        write: (event) => events.push(event),
      });

      assert.deepEqual(runs, [
        ['one', 'fine'],
        ['three', undefined],
      ]);
      const error = events.find((event) => event.type === 'error');
      assert.equal(error?.type === 'error' ? error.id : undefined, 'r2');
      assert.deepEqual(
        events.map((event) => [event.type, 'id' in event ? event.id : undefined]),
        [
          ['ready', undefined],
          ['run-start', 'r1'],
          ['run', 'r1'],
          ['error', 'r2'],
          ['run-start', 'r3'],
          ['run', 'r3'],
        ]
      );
    });
  });
});
