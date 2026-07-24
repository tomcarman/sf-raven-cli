import assert from 'node:assert/strict';
import {
  formatRecordTable,
  queryRecords,
  type RecordQueryConnection,
  type RecordQueryResult,
} from '../../src/shared/recordQuery.js';

type FakeConnectionOptions = {
  sobjects?: Array<{ name: string; keyPrefix?: string | null }>;
  fields?: Array<{ name: string; type: string; queryable?: boolean }>;
  records?: Array<Record<string, unknown>>;
};

type FakeConnection = RecordQueryConnection & {
  describeGlobalCalls: number;
  describedObjects: string[];
  queries: string[];
};

const accountId = '001Kf00001aBcDeFGH';
const otherAccountId = '001Kf00001zYxWvUTS';

const createFakeConnection = ({
  sobjects = [
    { name: 'Account', keyPrefix: '001' },
    { name: 'Contact', keyPrefix: '003' },
    { name: 'RecordType', keyPrefix: null },
  ],
  fields = [
    { name: 'Id', type: 'id' },
    { name: 'Name', type: 'string' },
  ],
  records = [{ attributes: { type: 'Account', url: '/services/data' }, Id: accountId, Name: 'Acme' }],
}: FakeConnectionOptions = {}): FakeConnection => {
  const connection: FakeConnection = {
    describeGlobalCalls: 0,
    describedObjects: [],
    queries: [],
    describeGlobal: () => {
      connection.describeGlobalCalls += 1;
      return Promise.resolve({ sobjects });
    },
    describe: (sobjectName: string) => {
      connection.describedObjects.push(sobjectName);
      return Promise.resolve({ fields });
    },
    query: (soql: string) => {
      connection.queries.push(soql);
      return Promise.resolve({ records: records.map((record) => ({ ...record })) });
    },
  };

  return connection;
};

const baseResult = (overrides: Partial<RecordQueryResult> = {}): RecordQueryResult => ({
  sobject: 'Account',
  fields: ['Id', 'Name'],
  idsRequested: [accountId],
  idsFound: [accountId],
  records: [{ Id: accountId, Name: 'Acme' }],
  ...overrides,
});

describe('record query', () => {
  describe('queryRecords', () => {
    it('detects the object from the id key prefix and queries every field', async () => {
      const connection = createFakeConnection();

      const result = await queryRecords(connection, { recordIds: accountId });

      assert.equal(result.sobject, 'Account');
      assert.deepEqual(connection.describedObjects, ['Account']);
      assert.deepEqual(connection.queries, [`SELECT Id, Name FROM Account WHERE Id IN ('${accountId}')`]);
    });

    it('returns the structured result with attributes stripped from records', async () => {
      const connection = createFakeConnection();

      const result = await queryRecords(connection, { recordIds: accountId });

      assert.deepEqual(result, {
        sobject: 'Account',
        fields: ['Id', 'Name'],
        idsRequested: [accountId],
        idsFound: [accountId],
        records: [{ Id: accountId, Name: 'Acme' }],
      });
    });

    it('always puts Id first even when the describe lists it elsewhere', async () => {
      const connection = createFakeConnection({
        fields: [
          { name: 'Name', type: 'string' },
          { name: 'Id', type: 'id' },
          { name: 'Industry', type: 'picklist' },
        ],
      });

      const result = await queryRecords(connection, { recordIds: accountId });

      assert.deepEqual(result.fields, ['Id', 'Name', 'Industry']);
      assert.deepEqual(connection.queries, [`SELECT Id, Name, Industry FROM Account WHERE Id IN ('${accountId}')`]);
    });

    it('filters base64 and non-queryable fields out of the field list', async () => {
      const connection = createFakeConnection({
        fields: [
          { name: 'Id', type: 'id' },
          { name: 'Blob__c', type: 'base64' },
          { name: 'Hidden__c', type: 'string', queryable: false },
          { name: 'Name', type: 'string', queryable: true },
        ],
      });

      const result = await queryRecords(connection, { recordIds: accountId });

      assert.deepEqual(result.fields, ['Id', 'Name']);
    });

    it('accepts multiple comma-delimited ids and queries them in one trip', async () => {
      const connection = createFakeConnection({
        records: [
          { attributes: { type: 'Account' }, Id: accountId, Name: 'Acme' },
          { attributes: { type: 'Account' }, Id: otherAccountId, Name: 'Globex' },
        ],
      });

      const result = await queryRecords(connection, { recordIds: ` ${accountId}, ${otherAccountId} ` });

      assert.deepEqual(result.idsRequested, [accountId, otherAccountId]);
      assert.deepEqual(result.idsFound, [accountId, otherAccountId]);
      assert.deepEqual(connection.queries, [
        `SELECT Id, Name FROM Account WHERE Id IN ('${accountId}', '${otherAccountId}')`,
      ]);
    });

    it('reports only the ids that returned a record in idsFound', async () => {
      const connection = createFakeConnection({
        records: [{ attributes: { type: 'Account' }, Id: accountId, Name: 'Acme' }],
      });

      const result = await queryRecords(connection, { recordIds: `${accountId},${otherAccountId}` });

      assert.deepEqual(result.idsRequested, [accountId, otherAccountId]);
      assert.deepEqual(result.idsFound, [accountId]);
    });

    it('rejects malformed ids before any API call', async () => {
      const connection = createFakeConnection();

      await assert.rejects(
        queryRecords(connection, { recordIds: `${accountId},not-an-id` }),
        /not-an-id/
      );

      assert.equal(connection.describeGlobalCalls, 0);
      assert.deepEqual(connection.describedObjects, []);
      assert.deepEqual(connection.queries, []);
    });

    it('rejects an empty id list before any API call', async () => {
      const connection = createFakeConnection();

      await assert.rejects(queryRecords(connection, { recordIds: ' , ' }), /No record ids/);

      assert.equal(connection.describeGlobalCalls, 0);
    });

    it('throws a detection error when no object matches the key prefix', async () => {
      const connection = createFakeConnection({ sobjects: [{ name: 'Contact', keyPrefix: '003' }] });

      await assert.rejects(queryRecords(connection, { recordIds: accountId }), /001/);
      assert.deepEqual(connection.describedObjects, []);
      assert.deepEqual(connection.queries, []);
    });
  });

  describe('formatRecordTable', () => {
    it('renders fields as rows with one column per record headed by its id', () => {
      const table = formatRecordTable(baseResult());

      assert.equal(
        table,
        [
          'Field  001Kf00001aBcDeFGH',
          '-----  ------------------',
          'Id     001Kf00001aBcDeFGH',
          'Name   Acme',
        ].join('\n')
      );
    });

    it('renders one column per record for multiple records', () => {
      const table = formatRecordTable(
        baseResult({
          idsRequested: [accountId, otherAccountId],
          idsFound: [accountId, otherAccountId],
          records: [
            { Id: accountId, Name: 'Acme' },
            { Id: otherAccountId, Name: 'Globex' },
          ],
        })
      );

      assert.equal(
        table,
        [
          'Field  001Kf00001aBcDeFGH  001Kf00001zYxWvUTS',
          '-----  ------------------  ------------------',
          'Id     001Kf00001aBcDeFGH  001Kf00001zYxWvUTS',
          'Name   Acme                Globex',
        ].join('\n')
      );
    });

    it('renders null values as blank cells', () => {
      const table = formatRecordTable(
        baseResult({
          fields: ['Id', 'Name', 'Industry'],
          records: [{ Id: accountId, Name: null, Industry: 'Tech' }],
        })
      );

      assert.equal(
        table,
        [
          'Field     001Kf00001aBcDeFGH',
          '--------  ------------------',
          'Id        001Kf00001aBcDeFGH',
          'Name',
          'Industry  Tech',
        ].join('\n')
      );
    });

    it('renders non-string values as JSON', () => {
      const table = formatRecordTable(
        baseResult({
          fields: ['Id', 'NumberOfEmployees', 'IsDeleted'],
          records: [{ Id: accountId, NumberOfEmployees: 42, IsDeleted: false }],
        })
      );

      assert.ok(table.includes('NumberOfEmployees  42'));
      assert.ok(table.includes('IsDeleted          false'));
    });

    it('truncates long values at 80 characters with an ellipsis by default', () => {
      const longValue = 'x'.repeat(100);
      const table = formatRecordTable(baseResult({ records: [{ Id: accountId, Name: longValue }] }));

      assert.ok(table.includes(`${'x'.repeat(80)}…`));
      assert.ok(!table.includes('x'.repeat(81)));
    });

    it('truncates at a custom width', () => {
      const table = formatRecordTable(baseResult({ records: [{ Id: accountId, Name: 'abcdefghij' }] }), {
        truncate: 5,
      });

      assert.ok(table.includes('abcde…'));
      assert.ok(!table.includes('abcdef…'));
    });

    it('does not truncate when the width is 0', () => {
      const longValue = 'x'.repeat(100);
      const table = formatRecordTable(baseResult({ records: [{ Id: accountId, Name: longValue }] }), {
        truncate: 0,
      });

      assert.ok(table.includes(longValue));
      assert.ok(!table.includes('…'));
    });
  });
});
