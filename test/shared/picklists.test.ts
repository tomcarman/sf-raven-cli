import assert from 'node:assert/strict';
import {
  formatDefaultMarker,
  isPicklistField,
  selectPicklistFields,
  toPicklistField,
  type DescribeFieldWithPicklist,
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
});
