import assert from 'node:assert/strict';
import {
  buildRecentQuery,
  defaultFields,
  findNameField,
  formatRelativeAge,
  formatSortDate,
  hasField,
  hasRecordTypes,
  mergeFields,
} from '../../src/shared/recentQuery.js';

const now = new Date('2026-07-28T12:00:00.000Z');
const ago = (seconds: number): string => new Date(now.getTime() - seconds * 1000).toISOString();

describe('recent query', () => {
  describe('findNameField', () => {
    it('finds the field describe flags as the name field', () => {
      assert.equal(findNameField([{ name: 'Id' }, { name: 'CaseNumber', nameField: true }]), 'CaseNumber');
    });

    it('returns nothing for objects with no name field', () => {
      assert.equal(findNameField([{ name: 'Id' }]), undefined);
    });
  });

  describe('hasField', () => {
    it('matches case-insensitively', () => {
      assert.equal(hasField([{ name: 'CreatedDate' }], 'createddate'), true);
      assert.equal(hasField([{ name: 'CreatedDate' }], 'LastModifiedDate'), false);
    });
  });

  describe('hasRecordTypes', () => {
    it('ignores the Master entry every object has', () => {
      assert.equal(hasRecordTypes({ fields: [], recordTypeInfos: [{ master: true }] }), false);
      assert.equal(hasRecordTypes({ fields: [] }), false);
    });

    it('is true once a real record type exists', () => {
      assert.equal(hasRecordTypes({ fields: [], recordTypeInfos: [{ master: true }, { master: false }] }), true);
    });
  });

  describe('defaultFields', () => {
    it('shows the created pair by default', () => {
      assert.deepEqual(defaultFields('Name', false), ['Id', 'Name', 'CreatedDate', 'CreatedBy.Username']);
    });

    it('swaps in the modified pair under --modified', () => {
      assert.deepEqual(defaultFields('Name', true), ['Id', 'Name', 'LastModifiedDate', 'LastModifiedBy.Username']);
    });

    it('omits the name column when the object has no name field', () => {
      assert.deepEqual(defaultFields(undefined, false), ['Id', 'CreatedDate', 'CreatedBy.Username']);
    });
  });

  describe('mergeFields', () => {
    const base = ['Id', 'Name', 'CreatedDate'];

    it('appends extra fields rather than replacing the defaults', () => {
      assert.deepEqual(mergeFields(base, 'Industry, Rating'), [...base, 'Industry', 'Rating']);
    });

    it('leaves the defaults alone when nothing extra is asked for', () => {
      assert.deepEqual(mergeFields(base, undefined), base);
      assert.deepEqual(mergeFields(base, ''), base);
    });

    it('does not repeat a field already in the defaults, whatever its case', () => {
      assert.deepEqual(mergeFields(base, 'name,Industry'), [...base, 'Industry']);
    });

    it('does not repeat a field named twice', () => {
      assert.deepEqual(mergeFields(base, 'Industry,industry'), [...base, 'Industry']);
    });
  });

  describe('buildRecentQuery', () => {
    const options = { sobject: 'Account', fields: ['Id', 'Name'], sortField: 'CreatedDate', limit: 10 };

    it('sorts newest first and applies the limit', () => {
      assert.equal(buildRecentQuery(options), 'SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 10');
    });

    it('filters on the record type developer name when asked', () => {
      assert.equal(
        buildRecentQuery({ ...options, recordType: 'Enterprise' }),
        "SELECT Id, Name FROM Account WHERE RecordType.DeveloperName = 'Enterprise' ORDER BY CreatedDate DESC LIMIT 10"
      );
    });

    it('escapes a quote in the record type name', () => {
      assert.equal(buildRecentQuery({ ...options, recordType: "O'Brien" }).includes("\\'Brien"), true);
    });
  });

  describe('formatRelativeAge', () => {
    it('describes ages in the largest sensible unit', () => {
      assert.equal(formatRelativeAge(ago(30), now), 'just now');
      assert.equal(formatRelativeAge(ago(60 * 5), now), '5m ago');
      assert.equal(formatRelativeAge(ago(60 * 60 * 2), now), '2h ago');
      assert.equal(formatRelativeAge(ago(60 * 60 * 24 * 3), now), '3d ago');
      assert.equal(formatRelativeAge(ago(60 * 60 * 24 * 60), now), '2mo ago');
      assert.equal(formatRelativeAge(ago(60 * 60 * 24 * 400), now), '1y ago');
    });

    it('treats a future timestamp as just now rather than a negative age', () => {
      assert.equal(formatRelativeAge(new Date(now.getTime() + 60_000).toISOString(), now), 'just now');
    });
  });

  describe('formatSortDate', () => {
    it('pairs the timestamp with its relative age', () => {
      assert.equal(formatSortDate(ago(60 * 60 * 2), now).endsWith(' (2h ago)'), true);
      assert.equal(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(/.test(formatSortDate(ago(60), now)), true);
    });

    it('renders a missing value as an empty cell', () => {
      assert.equal(formatSortDate(null, now), '');
      assert.equal(formatSortDate(undefined, now), '');
      assert.equal(formatSortDate('', now), '');
    });
  });
});
