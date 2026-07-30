import assert from 'node:assert/strict';
import {
  buildHistoryQuery,
  findHistoryRelationship,
  formatHistoryDate,
  formatHistoryValue,
  groupHistoryByRecord,
  isEventField,
  toHistoryRow,
  type ChildRelationship,
  type HistoryRecord,
} from '../../src/shared/recordHistory.js';

const historyRecord = (overrides: Partial<HistoryRecord> = {}): HistoryRecord => ({
  Field: 'Industry',
  OldValue: 'Banking',
  NewValue: 'Media',
  CreatedDate: '2026-07-28T09:14:00.000+0000',
  CreatedBy: { Username: 'tom@example.test' },
  ...overrides,
});

describe('record history', () => {
  describe('findHistoryRelationship', () => {
    const child = (childSObject: string, field: string): ChildRelationship => ({ childSObject, field });

    it('finds the standard <Object>History child', () => {
      assert.deepEqual(
        findHistoryRelationship('Account', [child('Contact', 'AccountId'), child('AccountHistory', 'AccountId')]),
        { object: 'AccountHistory', field: 'AccountId' }
      );
    });

    it('finds the <Object>FieldHistory variant', () => {
      assert.deepEqual(findHistoryRelationship('Opportunity', [child('OpportunityFieldHistory', 'OpportunityId')]), {
        object: 'OpportunityFieldHistory',
        field: 'OpportunityId',
      });
    });

    it('prefers FieldHistory over History when the object has both', () => {
      assert.deepEqual(
        findHistoryRelationship('Opportunity', [
          child('ActivityHistory', 'WhatId'),
          child('OpportunityHistory', 'OpportunityId'),
          child('OpportunityFieldHistory', 'OpportunityId'),
          child('ProcessInstanceHistory', 'TargetObjectId'),
          child('RecordActionHistory', 'ParentRecordId'),
        ]),
        { object: 'OpportunityFieldHistory', field: 'OpportunityId' }
      );
    });

    it('ignores the history children every object carries', () => {
      assert.equal(
        findHistoryRelationship('Bird__c', [
          child('ActivityHistory', 'WhatId'),
          child('ProcessInstanceHistory', 'TargetObjectId'),
          child('RecordActionHistory', 'ParentRecordId'),
        ]),
        undefined
      );
    });

    it('declines a lone History child that is not named after the object', () => {
      // ActivityFieldHistory is Task's only History child but has no Field
      // column, so guessing it would fail with a raw SOQL error.
      assert.equal(
        findHistoryRelationship('Task', [
          child('ActivityHistory', 'WhatId'),
          child('ActivityFieldHistory', 'TaskId'),
          child('ProcessInstanceHistory', 'TargetObjectId'),
        ]),
        undefined
      );
    });

    it('finds the custom object __History variant', () => {
      assert.deepEqual(findHistoryRelationship('Invoice__c', [child('Invoice__History', 'ParentId')]), {
        object: 'Invoice__History',
        field: 'ParentId',
      });
    });

    it('returns nothing when the object has no history child', () => {
      assert.equal(findHistoryRelationship('Account', [child('Contact', 'AccountId')]), undefined);
      assert.equal(findHistoryRelationship('Account', []), undefined);
    });

    it('prefers the name derived from the object over another history child', () => {
      assert.deepEqual(
        findHistoryRelationship('User', [child('LoginHistory', 'UserId'), child('UserHistory', 'UserId')]),
        { object: 'UserHistory', field: 'UserId' }
      );
    });

    it('declines history children that are not named after the object', () => {
      assert.equal(
        findHistoryRelationship('User', [child('LoginHistory', 'UserId'), child('LoginIpHistory', 'UsersId')]),
        undefined
      );
      assert.equal(findHistoryRelationship('Account', [child('LegacyAccountHistory', 'AccountId')]), undefined);
    });

    it('ignores a relationship with no lookup field', () => {
      assert.equal(findHistoryRelationship('Account', [child('AccountHistory', '')]), undefined);
    });
  });

  describe('buildHistoryQuery', () => {
    it('selects the parent lookup so rows can be grouped, newest first', () => {
      assert.equal(
        buildHistoryQuery({ object: 'AccountHistory', field: 'AccountId' }, ['001A', '001B']),
        "SELECT AccountId, Field, OldValue, NewValue, CreatedDate, CreatedBy.Username FROM AccountHistory WHERE AccountId IN ('001A', '001B') ORDER BY CreatedDate DESC"
      );
    });
  });

  describe('isEventField', () => {
    it('treats a valueless lifecycle field as an event', () => {
      assert.equal(isEventField(historyRecord({ Field: 'created', OldValue: null, NewValue: null })), true);
      assert.equal(isEventField(historyRecord({ Field: 'ownerAssignment', OldValue: null, NewValue: null })), true);
    });

    it('does not treat an ordinary field change as an event', () => {
      assert.equal(isEventField(historyRecord()), false);
    });

    it('does not treat a cleared field as an event', () => {
      assert.equal(isEventField(historyRecord({ OldValue: 'Banking', NewValue: null })), false);
      assert.equal(isEventField(historyRecord({ OldValue: null, NewValue: null })), false);
    });
  });

  describe('toHistoryRow', () => {
    it('maps an ordinary field change', () => {
      assert.deepEqual(toHistoryRow(historyRecord()), {
        date: '2026-07-28T09:14:00.000+0000',
        field: 'Industry',
        oldValue: 'Banking',
        newValue: 'Media',
        changedBy: 'tom@example.test',
        isEvent: false,
      });
    });

    it('labels lifecycle events instead of showing the raw token', () => {
      const row = toHistoryRow(historyRecord({ Field: 'created', OldValue: null, NewValue: null }));

      assert.equal(row.field, 'Record created');
      assert.equal(row.isEvent, true);
    });

    it('survives a missing CreatedBy', () => {
      assert.equal(toHistoryRow(historyRecord({ CreatedBy: null })).changedBy, '');
    });

    it('keeps paired lookup rows as returned rather than merging them', () => {
      const rows = [
        historyRecord({ Field: 'Owner', OldValue: '005A', NewValue: '005B' }),
        historyRecord({ Field: 'Owner', OldValue: 'Alex', NewValue: 'Sam' }),
      ].map(toHistoryRow);

      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((row) => row.oldValue),
        ['005A', 'Alex']
      );
    });
  });

  describe('groupHistoryByRecord', () => {
    it('groups rows under the record they belong to', () => {
      const grouped = groupHistoryByRecord(
        [
          { ...historyRecord(), AccountId: '001aj00003BxWlZAAV' },
          { ...historyRecord({ Field: 'Rating' }), AccountId: '001aj00003BxWlZAAV' },
          { ...historyRecord(), AccountId: '001KZ00000Bw3wpYAB' },
        ],
        'AccountId',
        ['001aj00003BxWlZAAV', '001KZ00000Bw3wpYAB']
      );

      assert.equal(grouped['001aj00003BxWlZAAV'].length, 2);
      assert.equal(grouped['001KZ00000Bw3wpYAB'].length, 1);
    });

    it('gives every requested record an entry, even with no rows', () => {
      const grouped = groupHistoryByRecord([], 'AccountId', ['001A', '001B']);

      assert.deepEqual(grouped, { '001A': [], '001B': [] });
    });

    it('matches 18-character results against 15-character requests', () => {
      const grouped = groupHistoryByRecord([{ ...historyRecord(), AccountId: '001aj00003BxWlZAAV' }], 'AccountId', [
        '001aj00003BxWlZ',
      ]);

      assert.equal(grouped['001aj00003BxWlZ'].length, 1);
    });

    it('ignores rows for records that were not asked for', () => {
      const grouped = groupHistoryByRecord([{ ...historyRecord(), AccountId: '001OTHER00000000' }], 'AccountId', [
        '001aj00003BxWlZAAV',
      ]);

      assert.deepEqual(grouped['001aj00003BxWlZAAV'], []);
    });
  });

  describe('formatHistoryValue', () => {
    it('renders values, blanks nulls, and dashes event rows', () => {
      assert.equal(formatHistoryValue('Banking', false), 'Banking');
      assert.equal(formatHistoryValue(null, false), '');
      assert.equal(formatHistoryValue(null, true), '-');
      assert.equal(formatHistoryValue(42, false), '42');
    });
  });

  describe('formatHistoryDate', () => {
    it('renders a readable timestamp', () => {
      assert.equal(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(formatHistoryDate('2026-07-28T09:14:00.000Z')), true);
    });
  });
});
