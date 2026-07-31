import assert from 'node:assert/strict';
import { executeSoql, type SoqlConnection, type SoqlQueryResponse } from '../../src/shared/soqlSession.js';

const response = (records: Array<Record<string, unknown>>, totalSize = records.length): SoqlQueryResponse => ({
  totalSize,
  done: true,
  records,
});

type Call = { api: 'data' | 'tooling'; soql: string };

const fakeConnection = (
  data: (soql: string) => Promise<SoqlQueryResponse>,
  tooling: (soql: string) => Promise<SoqlQueryResponse>,
  calls: Call[]
): SoqlConnection => ({
  query: (soql) => {
    calls.push({ api: 'data', soql });
    return data(soql);
  },
  tooling: {
    query: (soql) => {
      calls.push({ api: 'tooling', soql });
      return tooling(soql);
    },
  },
});

const invalidType = (): Error =>
  Object.assign(new Error('INVALID_TYPE: sObject type is not supported'), {
    errorCode: 'INVALID_TYPE',
  });

describe('executeSoql', () => {
  it('injects the auto-limit and reports when it was hit', async () => {
    const calls: Call[] = [];
    const connection = fakeConnection(
      async () => response([{ Id: '1' }, { Id: '2' }]),
      async () => response([]),
      calls
    );

    const execution = await executeSoql(connection, 'SELECT Id FROM Account', { autoLimit: 2, toolingMode: 'auto' });

    assert.equal(calls[0].soql, 'SELECT Id FROM Account LIMIT 2');
    assert.equal(execution.injectedLimit, 2);
    assert.equal(execution.injectedLimitHit, true);
    assert.equal(execution.rowCount, 2);
  });

  it('does not report a hit when fewer rows come back', async () => {
    const connection = fakeConnection(
      async () => response([{ Id: '1' }]),
      async () => response([]),
      []
    );

    const execution = await executeSoql(connection, 'SELECT Id FROM Account', { autoLimit: 2, toolingMode: 'auto' });

    assert.equal(execution.injectedLimitHit, false);
  });

  it('leaves a query with its own LIMIT alone', async () => {
    const calls: Call[] = [];
    const connection = fakeConnection(
      async () => response([]),
      async () => response([]),
      calls
    );

    const execution = await executeSoql(connection, 'SELECT Id FROM Account LIMIT 5', {
      autoLimit: 2000,
      toolingMode: 'auto',
    });

    assert.equal(calls[0].soql, 'SELECT Id FROM Account LIMIT 5');
    assert.equal(execution.injectedLimit, undefined);
  });

  it('falls back to the Tooling API on INVALID_TYPE', async () => {
    const calls: Call[] = [];
    const connection = fakeConnection(
      async () => {
        throw invalidType();
      },
      async () => response([{ Id: '01p' }]),
      calls
    );

    const execution = await executeSoql(connection, 'SELECT Id FROM ApexClass LIMIT 1', {
      autoLimit: 2000,
      toolingMode: 'auto',
    });

    assert.deepEqual(
      calls.map((call) => call.api),
      ['data', 'tooling']
    );
    assert.equal(execution.usedTooling, true);
    assert.equal(execution.rowCount, 1);
  });

  it('propagates non-INVALID_TYPE errors without retrying', async () => {
    const calls: Call[] = [];
    const connection = fakeConnection(
      async () => {
        throw new Error('MALFORMED_QUERY: unexpected token');
      },
      async () => response([]),
      calls
    );

    await assert.rejects(
      executeSoql(connection, 'SELECT FROM Account', { autoLimit: 0, toolingMode: 'auto' }),
      /MALFORMED_QUERY/
    );
    assert.deepEqual(
      calls.map((call) => call.api),
      ['data']
    );
  });

  it('routes straight to the Tooling API when forced on', async () => {
    const calls: Call[] = [];
    const connection = fakeConnection(
      async () => response([]),
      async () => response([{ Id: '01p' }]),
      calls
    );

    const execution = await executeSoql(connection, 'SELECT Id FROM ApexClass LIMIT 1', {
      autoLimit: 2000,
      toolingMode: 'on',
    });

    assert.deepEqual(
      calls.map((call) => call.api),
      ['tooling']
    );
    assert.equal(execution.usedTooling, true);
  });

  it('never retries via tooling when forced off', async () => {
    const calls: Call[] = [];
    const connection = fakeConnection(
      async () => {
        throw invalidType();
      },
      async () => response([]),
      calls
    );

    await assert.rejects(
      executeSoql(connection, 'SELECT Id FROM ApexClass', { autoLimit: 0, toolingMode: 'off' }),
      /INVALID_TYPE/
    );
    assert.deepEqual(
      calls.map((call) => call.api),
      ['data']
    );
  });

  it('strips attributes, including inside subquery record arrays', async () => {
    const connection = fakeConnection(
      async () =>
        response([
          {
            attributes: { type: 'Account' },
            Id: '1',
            Contacts: {
              totalSize: 1,
              done: true,
              records: [{ attributes: { type: 'Contact' }, Id: 'c1' }],
            },
          },
        ]),
      async () => response([]),
      []
    );

    const execution = await executeSoql(connection, 'SELECT Id, (SELECT Id FROM Contacts) FROM Account LIMIT 1', {
      autoLimit: 2000,
      toolingMode: 'auto',
    });

    assert.deepEqual(execution.records, [{ Id: '1', Contacts: { totalSize: 1, done: true, records: [{ Id: 'c1' }] } }]);
    assert.deepEqual(execution.fields, ['Id', 'Contacts']);
  });

  it('synthesizes a row for a bare COUNT() query', async () => {
    const connection = fakeConnection(
      async () => response([], 42),
      async () => response([]),
      []
    );

    const execution = await executeSoql(connection, 'SELECT COUNT() FROM Account', {
      autoLimit: 2000,
      toolingMode: 'auto',
    });

    assert.deepEqual(execution.records, [{ 'COUNT()': 42 }]);
    assert.deepEqual(execution.fields, ['COUNT()']);
    assert.equal(execution.injectedLimit, undefined);
  });

  it('re-aliases aggregate expr columns end to end', async () => {
    const connection = fakeConnection(
      async () => response([{ attributes: { type: 'AggregateResult' }, StageName: 'Won', expr0: 3 }]),
      async () => response([]),
      []
    );

    const execution = await executeSoql(
      connection,
      'SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName LIMIT 10',
      { autoLimit: 2000, toolingMode: 'auto' }
    );

    assert.deepEqual(execution.records, [{ StageName: 'Won', 'COUNT(Id)': 3 }]);
    assert.deepEqual(execution.fields, ['StageName', 'COUNT(Id)']);
  });
});
