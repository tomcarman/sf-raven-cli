import assert from 'node:assert/strict';
import {
  applyAvailability,
  formatAvailabilityCell,
  formatDefaultMarker,
  isPicklistField,
  masterRecordTypeId,
  masterRecordTypeName,
  selectPicklistFields,
  toPicklistField,
  type DescribeFieldWithPicklist,
  type RecordTypeAvailability,
  type RecordTypeColumn,
} from '../../src/shared/picklists.js';

const picklist = (
  name: string,
  values: Array<[string, string, boolean, boolean]>,
  overrides: Partial<DescribeFieldWithPicklist> = {}
): DescribeFieldWithPicklist => ({
  name,
  label: name,
  type: 'picklist',
  picklistValues: values.map(([value, label, active, defaultValue]) => ({ value, label, active, defaultValue })),
  ...overrides,
});

const fields: DescribeFieldWithPicklist[] = [
  { name: 'Name', label: 'Name', type: 'string' },
  picklist('Industry', [
    ['Banking', 'Banking', true, false],
    ['Retired', 'Retired', false, false],
    ['Media', 'Media', true, true],
  ]),
  picklist('Interests__c', [['Golf', 'Golf', true, false]], { type: 'multipicklist' }),
  picklist('City__c', [['Leeds', 'Leeds', true, false]], { controllerName: 'Country__c' }),
];

describe('picklists', () => {
  describe('isPicklistField', () => {
    it('accepts single and multi-select picklists and nothing else', () => {
      assert.equal(isPicklistField({ name: 'a', label: 'a', type: 'picklist' }), true);
      assert.equal(isPicklistField({ name: 'a', label: 'a', type: 'multipicklist' }), true);
      assert.equal(isPicklistField({ name: 'a', label: 'a', type: 'string' }), false);
      assert.equal(isPicklistField({ name: 'a', label: 'a', type: 'reference' }), false);
    });
  });

  describe('selectPicklistFields', () => {
    it('returns every picklist field by default', () => {
      assert.deepEqual(
        selectPicklistFields(fields, 'Account').map((field) => field.name),
        ['Industry', 'Interests__c', 'City__c']
      );
    });

    it('narrows to named fields, case-insensitively, in the order given', () => {
      assert.deepEqual(
        selectPicklistFields(fields, 'Account', 'city__C, Industry').map((field) => field.name),
        ['City__c', 'Industry']
      );
    });

    it('reports a field that does not exist', () => {
      assert.throws(() => selectPicklistFields(fields, 'Account', 'Nope'), /Unknown field\(s\) on Account: Nope/);
    });

    it('reports a real field that is not a picklist separately', () => {
      assert.throws(() => selectPicklistFields(fields, 'Account', 'Name'), /Not a picklist field on Account: Name/);
    });
  });

  describe('toPicklistField', () => {
    it('keeps only active values, with label and API name', () => {
      const field = toPicklistField(fields[1]);

      assert.deepEqual(field.values, [
        { value: 'Banking', label: 'Banking', isDefault: false },
        { value: 'Media', label: 'Media', isDefault: true },
      ]);
    });

    it('flags multi-select fields', () => {
      assert.equal(toPicklistField(fields[2]).multiSelect, true);
      assert.equal(toPicklistField(fields[1]).multiSelect, false);
    });

    it('carries the controlling field for dependent picklists', () => {
      assert.equal(toPicklistField(fields[3]).controllerName, 'Country__c');
      assert.equal(Object.hasOwn(toPicklistField(fields[1]), 'controllerName'), false);
    });

    it('treats an empty controllerName as no controller', () => {
      const field = toPicklistField(picklist('A', [], { controllerName: '' }));

      assert.equal(Object.hasOwn(field, 'controllerName'), false);
    });

    it('falls back to the API name when a value has no label', () => {
      const field = toPicklistField({
        name: 'A',
        label: 'A',
        type: 'picklist',
        picklistValues: [{ value: 'RAW', label: null, active: true, defaultValue: false }],
      });

      assert.equal(field.values[0].label, 'RAW');
    });

    it('handles a field with no picklistValues at all', () => {
      assert.deepEqual(toPicklistField({ name: 'A', label: 'A', type: 'picklist' }).values, []);
    });
  });

  describe('formatDefaultMarker', () => {
    it('marks the default value only', () => {
      assert.equal(formatDefaultMarker(true), '*');
      assert.equal(formatDefaultMarker(false), '');
    });
  });

  describe('record-type availability', () => {
    const stage = toPicklistField(
      picklist('StageName', [
        ['Prospecting', 'Prospecting', true, false],
        ['Closed Won', 'Closed Won', true, false],
      ])
    );

    const column = (developerName: string, accessible = true): RecordTypeColumn => ({
      id: developerName === masterRecordTypeName ? masterRecordTypeId : `012${developerName}`,
      developerName,
      name: developerName,
      accessible,
    });

    const columns = [column(masterRecordTypeName), column('Open'), column('Closed')];

    const responses = new Map<string, RecordTypeAvailability>([
      [masterRecordTypeName, new Map([['StageName', { values: new Set(['Prospecting', 'Closed Won']) }]])],
      ['Open', new Map([['StageName', { values: new Set(['Prospecting']), defaultValue: 'Prospecting' }]])],
      ['Closed', new Map([['StageName', { values: new Set(['Closed Won']) }]])],
    ]);

    describe('applyAvailability', () => {
      it('records which record types offer each value', () => {
        const [field] = applyAvailability([stage], columns, responses);

        assert.deepEqual(field.values[0].availability, { Master: true, Open: true, Closed: false });
        assert.deepEqual(field.values[1].availability, { Master: true, Open: false, Closed: true });
      });

      it('records the per-record-type default separately from the global one', () => {
        const [field] = applyAvailability([stage], columns, responses);

        assert.deepEqual(field.values[0].defaultFor, { Master: false, Open: true, Closed: false });
        assert.equal(field.values[0].isDefault, false, 'the global default is untouched');
      });

      it('leaves an unreadable record type out of both maps', () => {
        const partial = new Map(responses);
        partial.set('Closed', undefined);

        const [field] = applyAvailability([stage], columns, partial);

        assert.equal(Object.hasOwn(field.values[0].availability ?? {}, 'Closed'), false);
        assert.deepEqual(Object.keys(field.values[0].availability ?? {}), ['Master', 'Open']);
      });

      it('marks a value unavailable when the record type returned no data for its field', () => {
        const [field] = applyAvailability([stage], [column('Open')], new Map([['Open', new Map()]]));

        assert.deepEqual(field.values[0].availability, { Open: false });
      });
    });

    describe('formatAvailabilityCell', () => {
      const [field] = applyAvailability([stage], columns, responses);

      it('ticks an available value', () => {
        assert.equal(formatAvailabilityCell(field.values[0], column(masterRecordTypeName)), '✓');
      });

      it('stars the record type that defaults to the value', () => {
        assert.equal(formatAvailabilityCell(field.values[0], column('Open')), '✓*');
      });

      it('leaves an unavailable value blank', () => {
        assert.equal(formatAvailabilityCell(field.values[0], column('Closed')), '');
      });

      it('dashes a record type that could not be read', () => {
        assert.equal(formatAvailabilityCell(field.values[0], column('Closed', false)), '-');
      });

      it('leaves the cell blank for a value with no availability data at all', () => {
        assert.equal(formatAvailabilityCell(stage.values[0], column('Open')), '');
      });
    });
  });
});
