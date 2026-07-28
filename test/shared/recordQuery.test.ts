import assert from 'node:assert/strict';
import { getEncodedQueryLength, maxEncodedQueryLength } from '../../src/shared/query.js';
import {
  formatRecordCsv,
  formatRecordJson,
  formatRecordTable,
  formatRecordToon,
  queryRecords,
  type RecordQueryConnection,
  type RecordQueryResult,
} from '../../src/shared/recordQuery.js';

type FakeConnectionOptions = {
  sobjects?: Array<{ name: string; keyPrefix?: string | null }>;
  fields?: Array<{ name: string; type: string; queryable?: boolean }>;
  records?: Array<Record<string, unknown>>;
  toolingSobjects?: Array<{ name: string; keyPrefix?: string | null }>;
  toolingFields?: Array<{ name: string; type: string; queryable?: boolean }>;
  toolingRecords?: Array<Record<string, unknown>>;
};

type FakeConnection = RecordQueryConnection & {
  describeGlobalCalls: number;
  describedObjects: string[];
  queries: string[];
  toolingDescribeGlobalCalls: number;
  toolingDescribedObjects: string[];
  toolingQueries: string[];
};

const accountId = '001Kf00001aBcDeFGH';
const otherAccountId = '001Kf00001zYxWvUTS';
const apexClassId = '01pKf00001aBcDeFGH';

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
  toolingSobjects = [{ name: 'ApexClass', keyPrefix: '01p' }],
  toolingFields = [
    { name: 'Id', type: 'id' },
    { name: 'Name', type: 'string' },
  ],
  toolingRecords = [{ attributes: { type: 'ApexClass', url: '/services/data' }, Id: apexClassId, Name: 'MyClass' }],
}: FakeConnectionOptions = {}): FakeConnection => {
  const connection: FakeConnection = {
    describeGlobalCalls: 0,
    describedObjects: [],
    queries: [],
    toolingDescribeGlobalCalls: 0,
    toolingDescribedObjects: [],
    toolingQueries: [],
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
    tooling: {
      describeGlobal: () => {
        connection.toolingDescribeGlobalCalls += 1;
        return Promise.resolve({ sobjects: toolingSobjects });
      },
      describe: (sobjectName: string) => {
        connection.toolingDescribedObjects.push(sobjectName);
        return Promise.resolve({ fields: toolingFields });
      },
      query: (soql: string) => {
        connection.toolingQueries.push(soql);
        return Promise.resolve({ records: toolingRecords.map((record) => ({ ...record })) });
      },
    },
  };

  return connection;
};

const selectedFields = (soql: string): string[] => soql.slice('SELECT '.length, soql.indexOf(' FROM ')).split(', ');

const projectRecord = (record: Record<string, unknown>, fields: string[]): Record<string, unknown> => {
  const projected: Record<string, unknown> = { attributes: { type: 'Account', url: '/services/data' } };

  for (const field of fields) {
    const segments = field.split('.');
    const value = segments.reduce<unknown>(
      (current, segment) =>
        current != null && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined,
      record
    );
    let target = projected;

    for (const segment of segments.slice(0, -1)) {
      if (target[segment] == null || typeof target[segment] !== 'object') {
        target[segment] = {};
      }

      target = target[segment] as Record<string, unknown>;
    }

    target[segments[segments.length - 1]] = value;
  }

  return projected;
};

const createProjectingConnection = (
  describeFields: Array<{ name: string; type: string }>,
  fullRecords: Array<Record<string, unknown>>
): FakeConnection => {
  const connection = createFakeConnection({ fields: describeFields });
  connection.query = (soql: string) => {
    connection.queries.push(soql);
    return Promise.resolve({ records: fullRecords.map((record) => projectRecord(record, selectedFields(soql))) });
  };

  return connection;
};

const baseResult = (overrides: Partial<RecordQueryResult> = {}): RecordQueryResult => ({
  sobject: 'Account',
  usedTooling: false,
  fields: ['Id', 'Name'],
  idsRequested: [accountId],
  idsFound: [accountId],
  idsNotFound: [],
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
        usedTooling: false,
        fields: ['Id', 'Name'],
        idsRequested: [accountId],
        idsFound: [accountId],
        idsNotFound: [],
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

    it('lists ids that returned no record in idsNotFound as supplied', async () => {
      const shortMissingId = otherAccountId.slice(0, 15);
      const connection = createFakeConnection({
        records: [{ attributes: { type: 'Account' }, Id: accountId, Name: 'Acme' }],
      });

      const result = await queryRecords(connection, { recordIds: `${accountId},${shortMissingId}` });

      assert.deepEqual(result.idsNotFound, [shortMissingId]);
      assert.deepEqual(result.records, [{ Id: accountId, Name: 'Acme' }]);
    });

    it('orders records by requested id order regardless of query return order', async () => {
      const connection = createFakeConnection({
        records: [
          { attributes: { type: 'Account' }, Id: otherAccountId, Name: 'Globex' },
          { attributes: { type: 'Account' }, Id: accountId, Name: 'Acme' },
        ],
      });

      const result = await queryRecords(connection, { recordIds: `${accountId},${otherAccountId}` });

      assert.deepEqual(result.idsFound, [accountId, otherAccountId]);
      assert.deepEqual(result.records, [
        { Id: accountId, Name: 'Acme' },
        { Id: otherAccountId, Name: 'Globex' },
      ]);
    });

    it('matches mixed 15- and 18-character ids to their returned records', async () => {
      const shortAccountId = accountId.slice(0, 15);
      const connection = createFakeConnection({
        records: [
          { attributes: { type: 'Account' }, Id: otherAccountId, Name: 'Globex' },
          { attributes: { type: 'Account' }, Id: accountId, Name: 'Acme' },
        ],
      });

      const result = await queryRecords(connection, { recordIds: `${shortAccountId},${otherAccountId}` });

      assert.deepEqual(result.idsRequested, [shortAccountId, otherAccountId]);
      assert.deepEqual(result.idsFound, [accountId, otherAccountId]);
      assert.deepEqual(result.idsNotFound, []);
      assert.deepEqual(result.records, [
        { Id: accountId, Name: 'Acme' },
        { Id: otherAccountId, Name: 'Globex' },
      ]);
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

    it('throws a detection error naming both APIs when no object matches the key prefix in either', async () => {
      const connection = createFakeConnection({
        sobjects: [{ name: 'Contact', keyPrefix: '003' }],
        toolingSobjects: [{ name: 'ApexClass', keyPrefix: '01p' }],
      });

      await assert.rejects(
        queryRecords(connection, { recordIds: accountId }),
        (error: Error) => error.message.includes('001') && error.message.includes('Tooling')
      );

      assert.equal(connection.describeGlobalCalls, 1);
      assert.equal(connection.toolingDescribeGlobalCalls, 1);
      assert.deepEqual(connection.describedObjects, []);
      assert.deepEqual(connection.toolingDescribedObjects, []);
      assert.deepEqual(connection.queries, []);
      assert.deepEqual(connection.toolingQueries, []);
    });

    it('resolves regular-API objects without touching the Tooling API', async () => {
      const connection = createFakeConnection();

      const result = await queryRecords(connection, { recordIds: accountId });

      assert.equal(result.sobject, 'Account');
      assert.equal(connection.toolingDescribeGlobalCalls, 0);
      assert.deepEqual(connection.toolingDescribedObjects, []);
      assert.deepEqual(connection.toolingQueries, []);
    });

    it('falls back to the Tooling API when the regular API does not know the prefix', async () => {
      const connection = createFakeConnection();

      const result = await queryRecords(connection, { recordIds: apexClassId });

      assert.equal(result.sobject, 'ApexClass');
      assert.equal(result.usedTooling, true, 'callers need to know history is unavailable');
      assert.equal(connection.describeGlobalCalls, 1);
      assert.equal(connection.toolingDescribeGlobalCalls, 1);
      assert.deepEqual(result.records, [{ Id: apexClassId, Name: 'MyClass' }]);
    });

    it('runs the describe and the query through the Tooling API for a tooling object', async () => {
      const connection = createFakeConnection();

      await queryRecords(connection, { recordIds: apexClassId });

      assert.deepEqual(connection.toolingDescribedObjects, ['ApexClass']);
      assert.deepEqual(connection.toolingQueries, [`SELECT Id, Name FROM ApexClass WHERE Id IN ('${apexClassId}')`]);
      assert.deepEqual(connection.describedObjects, []);
      assert.deepEqual(connection.queries, []);
    });

    it('applies field selection against the Tooling API describe for a tooling object', async () => {
      const connection = createFakeConnection({
        toolingFields: [
          { name: 'Id', type: 'id' },
          { name: 'Name', type: 'string' },
          { name: 'ApiVersion', type: 'double' },
          { name: 'Body', type: 'string' },
        ],
      });

      const result = await queryRecords(connection, { recordIds: apexClassId, fields: 'apiversion,Name' });

      assert.deepEqual(result.fields, ['Id', 'ApiVersion', 'Name']);
      assert.deepEqual(connection.toolingQueries, [
        `SELECT Id, ApiVersion, Name FROM ApexClass WHERE Id IN ('${apexClassId}')`,
      ]);
    });

    it('reports tooling ids that returned no record in idsNotFound', async () => {
      const missingApexClassId = '01pKf00001zYxWvUTS';
      const connection = createFakeConnection();

      const result = await queryRecords(connection, { recordIds: `${apexClassId},${missingApexClassId}` });

      assert.deepEqual(result.idsFound, [apexClassId]);
      assert.deepEqual(result.idsNotFound, [missingApexClassId]);
    });

    it('replaces the field list with the requested fields, keeping Id first', async () => {
      const connection = createFakeConnection({
        fields: [
          { name: 'Id', type: 'id' },
          { name: 'Name', type: 'string' },
          { name: 'Industry', type: 'picklist' },
          { name: 'AnnualRevenue', type: 'currency' },
        ],
      });

      const result = await queryRecords(connection, { recordIds: accountId, fields: 'Industry,Name' });

      assert.deepEqual(result.fields, ['Id', 'Industry', 'Name']);
      assert.deepEqual(connection.queries, [`SELECT Id, Industry, Name FROM Account WHERE Id IN ('${accountId}')`]);
    });

    it('validates requested fields case-insensitively and outputs canonical casing', async () => {
      const connection = createFakeConnection({
        fields: [
          { name: 'Id', type: 'id' },
          { name: 'Name', type: 'string' },
          { name: 'Industry', type: 'picklist' },
        ],
      });

      const result = await queryRecords(connection, { recordIds: accountId, fields: ' industry , NAME ' });

      assert.deepEqual(result.fields, ['Id', 'Industry', 'Name']);
      assert.deepEqual(connection.queries, [`SELECT Id, Industry, Name FROM Account WHERE Id IN ('${accountId}')`]);
    });

    it('does not duplicate Id when it is explicitly requested', async () => {
      const connection = createFakeConnection();

      const result = await queryRecords(connection, { recordIds: accountId, fields: 'id,Name' });

      assert.deepEqual(result.fields, ['Id', 'Name']);
    });

    it('fails fast with one error naming every unknown requested field', async () => {
      const connection = createFakeConnection({
        fields: [
          { name: 'Id', type: 'id' },
          { name: 'Name', type: 'string' },
        ],
      });

      await assert.rejects(
        queryRecords(connection, { recordIds: accountId, fields: 'Name,Foo__c,Bar' }),
        (error: Error) => error.message.includes('Foo__c') && error.message.includes('Bar') && error.message.includes('Account')
      );

      assert.deepEqual(connection.queries, []);
    });

    it('passes dot-notation relationship paths through unvalidated', async () => {
      const connection = createFakeConnection({
        records: [
          {
            attributes: { type: 'Account' },
            Id: accountId,
            Name: 'Acme',
            Owner: { attributes: { type: 'User' }, Name: 'Jane' },
          },
        ],
      });

      const result = await queryRecords(connection, { recordIds: accountId, fields: 'Name,Owner.Name' });

      assert.deepEqual(result.fields, ['Id', 'Name', 'Owner.Name']);
      assert.deepEqual(connection.queries, [`SELECT Id, Name, Owner.Name FROM Account WHERE Id IN ('${accountId}')`]);
      assert.deepEqual(result.records, [{ Id: accountId, Name: 'Acme', Owner: { Name: 'Jane' } }]);
    });

    it('adds extra fields on top of the full field list', async () => {
      const connection = createFakeConnection({
        fields: [
          { name: 'Id', type: 'id' },
          { name: 'Name', type: 'string' },
          { name: 'Industry', type: 'picklist' },
        ],
      });

      const result = await queryRecords(connection, {
        recordIds: accountId,
        extraFields: 'Owner.Name,Owner.Profile.Name',
      });

      assert.deepEqual(result.fields, ['Id', 'Name', 'Industry', 'Owner.Name', 'Owner.Profile.Name']);
      assert.deepEqual(connection.queries, [
        `SELECT Id, Name, Industry, Owner.Name, Owner.Profile.Name FROM Account WHERE Id IN ('${accountId}')`,
      ]);
    });

    it('does not duplicate extra fields already present in the full field list', async () => {
      const connection = createFakeConnection({
        fields: [
          { name: 'Id', type: 'id' },
          { name: 'Name', type: 'string' },
          { name: 'Industry', type: 'picklist' },
        ],
      });

      const result = await queryRecords(connection, { recordIds: accountId, extraFields: 'name,Owner.Name' });

      assert.deepEqual(result.fields, ['Id', 'Name', 'Industry', 'Owner.Name']);
    });

    it('fails fast on unknown plain names in extra fields', async () => {
      const connection = createFakeConnection({
        fields: [
          { name: 'Id', type: 'id' },
          { name: 'Name', type: 'string' },
        ],
      });

      await assert.rejects(
        queryRecords(connection, { recordIds: accountId, extraFields: 'Owner.Name,Nope' }),
        /Nope/
      );

      assert.deepEqual(connection.queries, []);
    });

    describe('field chunking', () => {
      const wideFieldNames = Array.from(
        { length: 500 },
        (_, index) => `Very_Long_Custom_Field_Name_${String(index).padStart(3, '0')}__c`
      );
      const wideDescribeFields = [
        { name: 'Id', type: 'id' },
        ...wideFieldNames.map((name) => ({ name, type: 'string' })),
      ];
      const buildWideRecord = (id: string, seed: string): Record<string, unknown> => ({
        Id: id,
        ...Object.fromEntries(wideFieldNames.map((name, index) => [name, `${seed}-${index}`])),
      });

      it('still issues a single query when the encoded query fits within the cap', async () => {
        const narrowFieldNames = wideFieldNames.slice(0, 50);
        const connection = createProjectingConnection(
          [{ name: 'Id', type: 'id' }, ...narrowFieldNames.map((name) => ({ name, type: 'string' }))],
          [
            {
              Id: accountId,
              ...Object.fromEntries(narrowFieldNames.map((name, index) => [name, `a-${index}`])),
            },
          ]
        );

        await queryRecords(connection, { recordIds: accountId });

        assert.equal(connection.queries.length, 1);
        assert.ok(getEncodedQueryLength(connection.queries[0]) <= maxEncodedQueryLength);
      });

      it('splits the field list across multiple queries that each include Id and the full id list', async () => {
        const connection = createProjectingConnection(wideDescribeFields, [buildWideRecord(accountId, 'a')]);

        const result = await queryRecords(connection, { recordIds: accountId });

        assert.ok(connection.queries.length > 1);

        for (const soql of connection.queries) {
          assert.ok(getEncodedQueryLength(soql) <= maxEncodedQueryLength);
          assert.ok(soql.startsWith('SELECT Id, '));
          assert.ok(soql.endsWith(`FROM Account WHERE Id IN ('${accountId}')`));
        }

        const queriedFields = connection.queries.flatMap((soql) => selectedFields(soql).slice(1));
        assert.deepEqual(queriedFields, wideFieldNames);
        assert.deepEqual(result.fields, ['Id', ...wideFieldNames]);
      });

      it('packs each chunk up to the cap boundary', async () => {
        const connection = createProjectingConnection(wideDescribeFields, [buildWideRecord(accountId, 'a')]);

        await queryRecords(connection, { recordIds: accountId });

        for (let index = 0; index < connection.queries.length - 1; index += 1) {
          const nextChunkFirstField = selectedFields(connection.queries[index + 1])[1];
          const extended = connection.queries[index].replace(' FROM ', `, ${nextChunkFirstField} FROM `);
          assert.ok(getEncodedQueryLength(extended) > maxEncodedQueryLength);
        }
      });

      it('merges chunked results into records identical to a single query', async () => {
        const connection = createProjectingConnection(wideDescribeFields, [buildWideRecord(accountId, 'a')]);

        const result = await queryRecords(connection, { recordIds: accountId });

        assert.ok(connection.queries.length > 1);
        assert.deepEqual(result.records, [buildWideRecord(accountId, 'a')]);
        assert.deepEqual(Object.keys(result.records[0]), result.fields);
        assert.deepEqual(result.idsFound, [accountId]);
        assert.deepEqual(result.idsNotFound, []);
      });

      it('merges multiple records by id across chunks regardless of return order', async () => {
        const connection = createProjectingConnection(wideDescribeFields, [
          buildWideRecord(otherAccountId, 'b'),
          buildWideRecord(accountId, 'a'),
        ]);

        const result = await queryRecords(connection, { recordIds: `${accountId},${otherAccountId}` });

        assert.ok(connection.queries.length > 1);
        assert.deepEqual(result.idsFound, [accountId, otherAccountId]);
        assert.deepEqual(result.records, [buildWideRecord(accountId, 'a'), buildWideRecord(otherAccountId, 'b')]);
      });

      it('reports ids that returned no record across chunked queries', async () => {
        const connection = createProjectingConnection(wideDescribeFields, [buildWideRecord(accountId, 'a')]);

        const result = await queryRecords(connection, { recordIds: `${accountId},${otherAccountId}` });

        assert.ok(connection.queries.length > 1);
        assert.deepEqual(result.idsFound, [accountId]);
        assert.deepEqual(result.idsNotFound, [otherAccountId]);
        assert.deepEqual(result.records, [buildWideRecord(accountId, 'a')]);
      });

      it('merges relationship fields split across chunks into one nested object', async () => {
        const connection = createProjectingConnection(wideDescribeFields, [
          {
            ...buildWideRecord(accountId, 'a'),
            Owner: { Name: 'Jane', Email: 'jane@example.com' },
          },
        ]);

        const result = await queryRecords(connection, {
          recordIds: accountId,
          fields: `Owner.Name,${wideFieldNames.join(',')},Owner.Email`,
        });

        const queryIndexOf = (field: string): number =>
          connection.queries.findIndex((soql) => selectedFields(soql).includes(field));

        assert.ok(connection.queries.length > 1);
        assert.notEqual(queryIndexOf('Owner.Name'), queryIndexOf('Owner.Email'));
        assert.deepEqual(result.records[0].Owner, { Name: 'Jane', Email: 'jane@example.com' });
      });
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

    it('keeps the full 18-character record ids in the header when truncate is below 18', () => {
      const table = formatRecordTable(
        baseResult({
          idsRequested: [accountId, otherAccountId],
          idsFound: [accountId, otherAccountId],
          records: [
            { Id: accountId, Name: 'Acme' },
            { Id: otherAccountId, Name: 'Globex' },
          ],
        }),
        { truncate: 10 }
      );

      const [header] = table.split('\n');
      assert.ok(header.includes(accountId));
      assert.ok(header.includes(otherAccountId));
      assert.ok(!header.includes('…'));
    });

    it('renders dot-notation paths as rows keyed by the path', () => {
      const table = formatRecordTable(
        baseResult({
          fields: ['Id', 'Name', 'Owner.Name'],
          records: [{ Id: accountId, Name: 'Acme', Owner: { Name: 'Jane' } }],
        })
      );

      assert.equal(
        table,
        [
          'Field       001Kf00001aBcDeFGH',
          '----------  ------------------',
          'Id          001Kf00001aBcDeFGH',
          'Name        Acme',
          'Owner.Name  Jane',
        ].join('\n')
      );
    });

    it('renders a blank cell when a relationship parent is null', () => {
      const table = formatRecordTable(
        baseResult({
          fields: ['Id', 'Name', 'Owner.Name'],
          records: [{ Id: accountId, Name: 'Acme', Owner: null }],
        })
      );

      assert.ok(table.includes('Owner.Name'));
      assert.ok(!table.includes('undefined'));
      assert.ok(!table.includes('null'));
    });

    it('keeps all-null rows by default', () => {
      const table = formatRecordTable(
        baseResult({
          fields: ['Id', 'Name', 'Industry'],
          records: [{ Id: accountId, Name: 'Acme', Industry: null }],
        })
      );

      assert.ok(table.includes('Industry'));
    });

    it('omits rows where the only record value is null when omitNull is set', () => {
      const table = formatRecordTable(
        baseResult({
          fields: ['Id', 'Name', 'Industry'],
          records: [{ Id: accountId, Name: 'Acme', Industry: null }],
        }),
        { omitNull: true }
      );

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

    it('keeps rows where at least one record has a value when omitNull is set', () => {
      const table = formatRecordTable(
        baseResult({
          fields: ['Id', 'Name', 'Industry', 'Website'],
          idsRequested: [accountId, otherAccountId],
          idsFound: [accountId, otherAccountId],
          records: [
            { Id: accountId, Name: 'Acme', Industry: null, Website: null },
            { Id: otherAccountId, Name: 'Globex', Industry: 'Tech', Website: null },
          ],
        }),
        { omitNull: true }
      );

      assert.ok(table.includes('Industry'));
      assert.ok(!table.includes('Website'));
    });

    it('treats unreachable relationship paths as null for omitNull', () => {
      const table = formatRecordTable(
        baseResult({
          fields: ['Id', 'Name', 'Owner.Name'],
          records: [{ Id: accountId, Name: 'Acme', Owner: null }],
        }),
        { omitNull: true }
      );

      assert.ok(!table.includes('Owner.Name'));
    });

    it('does not omit rows whose value is falsy but not null', () => {
      const table = formatRecordTable(
        baseResult({
          fields: ['Id', 'Name', 'IsDeleted', 'NumberOfEmployees'],
          records: [{ Id: accountId, Name: '', IsDeleted: false, NumberOfEmployees: 0 }],
        }),
        { omitNull: true }
      );

      assert.ok(table.includes('Name'));
      assert.ok(table.includes('IsDeleted'));
      assert.ok(table.includes('NumberOfEmployees'));
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

  describe('formatRecordJson', () => {
    it('renders the raw records array with no envelope', () => {
      const json = formatRecordJson(baseResult());

      assert.deepEqual(JSON.parse(json), [{ Id: accountId, Name: 'Acme' }]);
      assert.ok(json.startsWith('['));
    });

    it('preserves the nested relationship shape', () => {
      const json = formatRecordJson(
        baseResult({
          fields: ['Id', 'Name', 'Owner.Name'],
          records: [{ Id: accountId, Name: 'Acme', Owner: { Name: 'Jane' } }],
        })
      );

      assert.deepEqual(JSON.parse(json), [{ Id: accountId, Name: 'Acme', Owner: { Name: 'Jane' } }]);
    });

    it('never truncates long values', () => {
      const longValue = 'x'.repeat(200);
      const json = formatRecordJson(baseResult({ records: [{ Id: accountId, Name: longValue }] }));

      assert.ok(json.includes(longValue));
      assert.ok(!json.includes('…'));
    });
  });

  describe('formatRecordCsv', () => {
    it('renders records as rows with one column per field', () => {
      const csv = formatRecordCsv(
        baseResult({
          idsRequested: [accountId, otherAccountId],
          idsFound: [accountId, otherAccountId],
          records: [
            { Id: accountId, Name: 'Acme' },
            { Id: otherAccountId, Name: 'Globex' },
          ],
        })
      );

      assert.equal(csv, ['Id,Name', `${accountId},Acme`, `${otherAccountId},Globex`].join('\n'));
    });

    it('escapes values containing commas, quotes, and newlines', () => {
      const csv = formatRecordCsv(
        baseResult({
          records: [{ Id: accountId, Name: 'Acme, "The" Corp\nLtd' }],
        })
      );

      assert.equal(csv, ['Id,Name', `${accountId},"Acme, ""The"" Corp\nLtd"`].join('\n'));
    });

    it('resolves dot-notation paths into their nested values', () => {
      const csv = formatRecordCsv(
        baseResult({
          fields: ['Id', 'Name', 'Owner.Name'],
          records: [{ Id: accountId, Name: 'Acme', Owner: { Name: 'Jane' } }],
        })
      );

      assert.equal(csv, ['Id,Name,Owner.Name', `${accountId},Acme,Jane`].join('\n'));
    });

    it('renders null values and null relationship parents as empty cells', () => {
      const csv = formatRecordCsv(
        baseResult({
          fields: ['Id', 'Name', 'Owner.Name'],
          records: [{ Id: accountId, Name: null, Owner: null }],
        })
      );

      assert.equal(csv, ['Id,Name,Owner.Name', `${accountId},,`].join('\n'));
    });

    it('never truncates long values', () => {
      const longValue = 'x'.repeat(200);
      const csv = formatRecordCsv(baseResult({ records: [{ Id: accountId, Name: longValue }] }));

      assert.ok(csv.includes(longValue));
      assert.ok(!csv.includes('…'));
    });
  });

  describe('formatRecordToon', () => {
    it('encodes the records array as TOON', () => {
      const toon = formatRecordToon(
        baseResult({
          idsRequested: [accountId, otherAccountId],
          idsFound: [accountId, otherAccountId],
          records: [
            { Id: accountId, Name: 'Acme' },
            { Id: otherAccountId, Name: 'Globex' },
          ],
        })
      );

      assert.equal(toon, [`[2]{Id,Name}:`, `  ${accountId},Acme`, `  ${otherAccountId},Globex`].join('\n'));
    });

    it('encodes nested relationship values', () => {
      const toon = formatRecordToon(
        baseResult({
          fields: ['Id', 'Name', 'Owner.Name'],
          records: [{ Id: accountId, Name: 'Acme', Owner: { Name: 'Jane' } }],
        })
      );

      assert.equal(toon, ['[1]{Id,Name,Owner{Name}}:', `  ${accountId},Acme,Jane`].join('\n'));
    });

    it('never truncates long values', () => {
      const longValue = 'x'.repeat(200);
      const toon = formatRecordToon(baseResult({ records: [{ Id: accountId, Name: longValue }] }));

      assert.ok(toon.includes(longValue));
      assert.ok(!toon.includes('…'));
    });
  });
});
