import assert from 'node:assert/strict';
import {
  buildDeepCountQuery,
  buildFieldUsage,
  buildSampleQuery,
  countPopulated,
  eligibleFields,
  formatUsageMethod,
  isDeepCountable,
  isPopulated,
  selectFields,
  sortFieldUsage,
  toPercent,
  type DescribeField,
  type FieldUsage,
} from '../../src/shared/fieldUsage.js';
import { stripAnsi, usageBar } from '../../src/shared/table.js';

const field = (overrides: Partial<DescribeField> & { name: string }): DescribeField => ({
  label: overrides.name,
  type: 'string',
  queryable: true,
  ...overrides,
});

const accountFields: DescribeField[] = [
  field({ name: 'Id' }),
  field({ name: 'Name' }),
  field({ name: 'BillingAddress', type: 'address' }),
  field({ name: 'BillingCity', compoundFieldName: 'BillingAddress' }),
  field({ name: 'BillingState', compoundFieldName: 'BillingAddress' }),
  field({ name: 'Photo', type: 'base64' }),
  field({ name: 'Hidden', queryable: false }),
  field({ name: 'Revenue__c', type: 'currency', custom: true }),
  field({ name: 'Score__c', type: 'double', custom: true }),
];

describe('field usage', () => {
  describe('eligibleFields', () => {
    it('drops compound parents but keeps their components', () => {
      const names = eligibleFields(accountFields).map((f) => f.name);

      assert.equal(names.includes('BillingAddress'), false);
      assert.equal(names.includes('BillingCity'), true);
      assert.equal(names.includes('BillingState'), true);
    });

    it('drops base64 and unqueryable fields', () => {
      const names = eligibleFields(accountFields).map((f) => f.name);

      assert.equal(names.includes('Photo'), false);
      assert.equal(names.includes('Hidden'), false);
    });

    it('keeps formula and other ordinary fields', () => {
      const names = eligibleFields([field({ name: 'Total__c', type: 'currency', custom: true })]).map((f) => f.name);

      assert.deepEqual(names, ['Total__c']);
    });
  });

  describe('selectFields', () => {
    it('returns every eligible field by default', () => {
      assert.equal(selectFields(accountFields, 'Account').length, eligibleFields(accountFields).length);
    });

    it('restricts to custom fields under customOnly', () => {
      const names = selectFields(accountFields, 'Account', { customOnly: true }).map((f) => f.name);

      assert.deepEqual(names, ['Revenue__c', 'Score__c']);
    });

    it('narrows to named fields, case-insensitively, in the order given', () => {
      const names = selectFields(accountFields, 'Account', { only: 'score__C, Name' }).map((f) => f.name);

      assert.deepEqual(names, ['Score__c', 'Name']);
    });

    it('rejects a field that does not exist', () => {
      assert.throws(() => selectFields(accountFields, 'Account', { only: 'Nope' }), /Nope/);
    });

    it('rejects a named field that was excluded as ineligible', () => {
      assert.throws(() => selectFields(accountFields, 'Account', { only: 'BillingAddress' }), /BillingAddress/);
    });

    it('applies customOnly before the name filter', () => {
      assert.throws(() => selectFields(accountFields, 'Account', { only: 'Name', customOnly: true }), /Name/);
    });
  });

  describe('buildSampleQuery', () => {
    it('takes the newest records, breaking ties on Id so chunks agree', () => {
      assert.equal(
        buildSampleQuery('Account', ['Id', 'Name'], 1000, true),
        'SELECT Id, Name FROM Account ORDER BY CreatedDate DESC, Id DESC LIMIT 1000'
      );
    });

    it('falls back to Id ordering when the object has no CreatedDate', () => {
      assert.equal(
        buildSampleQuery('Setup__x', ['Id'], 50, false),
        'SELECT Id FROM Setup__x ORDER BY Id DESC LIMIT 50'
      );
    });
  });

  describe('isPopulated', () => {
    it('treats null, undefined, and the empty string as unpopulated', () => {
      assert.equal(isPopulated(null), false);
      assert.equal(isPopulated(undefined), false);
      assert.equal(isPopulated(''), false);
    });

    it('treats zero and false as populated values', () => {
      assert.equal(isPopulated(0), true);
      assert.equal(isPopulated(false), true);
    });
  });

  describe('countPopulated', () => {
    it('counts per field across the sample', () => {
      const counts = countPopulated(
        [
          { Name: 'a', Score__c: 1 },
          { Name: 'b', Score__c: null },
          { Name: '', Score__c: 0 },
        ],
        ['Name', 'Score__c']
      );

      assert.equal(counts.get('Name'), 2);
      assert.equal(counts.get('Score__c'), 2);
    });

    it('reports zero for a field absent from every record', () => {
      const counts = countPopulated([{ Name: 'a' }], ['Name', 'Missing__c']);

      assert.equal(counts.get('Missing__c'), 0);
    });
  });

  describe('toPercent', () => {
    it('rounds to one decimal place', () => {
      assert.equal(toPercent(1, 3), 33.3);
      assert.equal(toPercent(11, 19), 57.9);
    });

    it('is zero rather than NaN for an empty sample', () => {
      assert.equal(toPercent(0, 0), 0);
    });
  });

  describe('sortFieldUsage', () => {
    it('puts the deadest fields first and breaks ties alphabetically', () => {
      const rows = buildFieldUsage(
        [field({ name: 'Zeta' }), field({ name: 'Alpha' }), field({ name: 'Busy' })],
        new Map([
          ['Zeta', 0],
          ['Alpha', 0],
          ['Busy', 5],
        ]),
        10,
        'sampled'
      );

      assert.deepEqual(
        sortFieldUsage(rows).map((row) => row.name),
        ['Alpha', 'Zeta', 'Busy']
      );
    });

    it('does not mutate the input', () => {
      const rows = buildFieldUsage([field({ name: 'B' }), field({ name: 'A' })], new Map(), 1, 'sampled');
      const before = rows.map((row) => row.name);

      sortFieldUsage(rows);

      assert.deepEqual(
        rows.map((row) => row.name),
        before
      );
    });
  });

  describe('deep mode', () => {
    const usage = (overrides: Partial<FieldUsage> = {}): FieldUsage => ({
      name: 'Industry',
      label: 'Industry',
      type: 'picklist',
      populated: 11,
      total: 19,
      percent: 57.9,
      method: 'deep',
      ...overrides,
    });

    describe('isDeepCountable', () => {
      it('counts filterable fields', () => {
        assert.equal(isDeepCountable(field({ name: 'Industry', type: 'picklist', filterable: true })), true);
      });

      it('skips fields that cannot be filtered on', () => {
        assert.equal(isDeepCountable(field({ name: 'Notes__c', type: 'textarea', filterable: false })), false);
        assert.equal(isDeepCountable(field({ name: 'Notes__c', type: 'textarea' })), false);
      });

      it('skips booleans, where "!= null" matches nothing in SOQL', () => {
        assert.equal(isDeepCountable(field({ name: 'IsDeleted', type: 'boolean', filterable: true })), false);
      });
    });

    describe('buildDeepCountQuery', () => {
      it('counts the records with a value', () => {
        assert.equal(buildDeepCountQuery('Account', 'Industry'), 'SELECT COUNT() FROM Account WHERE Industry != null');
      });
    });

    describe('formatUsageMethod', () => {
      it('marks a sampled field only when the object was counted deeply', () => {
        assert.equal(stripAnsi(formatUsageMethod(usage({ method: 'sampled' }), 'deep')), ' (sampled)');
        assert.equal(formatUsageMethod(usage({ method: 'deep' }), 'deep'), '');
        assert.equal(formatUsageMethod(usage({ method: 'sampled' }), 'sampled'), '');
      });
    });

  });

  describe('usageBar', () => {
    it('fills the bar in proportion to the percentage', () => {
      assert.equal(stripAnsi(usageBar(0)), '░'.repeat(10));
      assert.equal(stripAnsi(usageBar(100)), '█'.repeat(10));
      assert.equal(stripAnsi(usageBar(48)), '█████░░░░░');
    });

    it('is always the same width', () => {
      for (const percent of [0, 5.3, 48, 99.9, 100]) {
        assert.equal(stripAnsi(usageBar(percent)).length, 10, String(percent));
      }
    });
  });
});
