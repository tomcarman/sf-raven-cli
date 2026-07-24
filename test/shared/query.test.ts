import assert from 'node:assert/strict';
import { escapeCsvValue, getEncodedQueryLength, isValidSalesforceId, maxEncodedQueryLength } from '../../src/shared/query.js';

describe('shared query helpers', () => {
  describe('isValidSalesforceId', () => {
    it('accepts a 15-character alphanumeric id', () => {
      assert.equal(isValidSalesforceId('001Kf00001aBcDe'), true);
    });

    it('accepts an 18-character alphanumeric id', () => {
      assert.equal(isValidSalesforceId('001Kf00001aBcDeFGH'), true);
    });

    it('rejects ids that are neither 15 nor 18 characters long', () => {
      assert.equal(isValidSalesforceId(''), false);
      assert.equal(isValidSalesforceId('001Kf00001aBcD'), false);
      assert.equal(isValidSalesforceId('001Kf00001aBcDeF'), false);
      assert.equal(isValidSalesforceId('001Kf00001aBcDeFGHI'), false);
    });

    it('rejects ids containing non-alphanumeric characters', () => {
      assert.equal(isValidSalesforceId('001Kf00001aBcD-'), false);
      assert.equal(isValidSalesforceId('001Kf00001aBcDe GH'), false);
    });
  });

  describe('escapeCsvValue', () => {
    it('renders null and undefined as an empty string', () => {
      assert.equal(escapeCsvValue(null), '');
      assert.equal(escapeCsvValue(undefined), '');
    });

    it('passes plain strings through unchanged', () => {
      assert.equal(escapeCsvValue('Acme Ltd'), 'Acme Ltd');
    });

    it('quotes values containing commas', () => {
      assert.equal(escapeCsvValue('Acme, Ltd'), '"Acme, Ltd"');
    });

    it('quotes values containing newlines or carriage returns', () => {
      assert.equal(escapeCsvValue('line one\nline two'), '"line one\nline two"');
      assert.equal(escapeCsvValue('line one\rline two'), '"line one\rline two"');
    });

    it('doubles embedded quotes and wraps the value in quotes', () => {
      assert.equal(escapeCsvValue('say "hello"'), '"say ""hello"""');
    });

    it('serializes non-string primitives via JSON', () => {
      assert.equal(escapeCsvValue(42), '42');
      assert.equal(escapeCsvValue(true), 'true');
    });

    it('serializes objects via JSON and escapes the result', () => {
      assert.equal(escapeCsvValue({ type: 'Account' }), '"{""type"":""Account""}"');
    });
  });

  describe('getEncodedQueryLength', () => {
    it('measures the url-encoded byte length of a query', () => {
      assert.equal(getEncodedQueryLength('SELECT Id'), 'SELECT%20Id'.length);
    });

    it('counts every encoded byte of multibyte characters', () => {
      assert.equal(getEncodedQueryLength('é'), '%C3%A9'.length);
    });

    it('exposes the safe REST url length limit of 14,000 bytes', () => {
      assert.equal(maxEncodedQueryLength, 14_000);
    });
  });
});
