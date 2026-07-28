import assert from 'node:assert/strict';
import {
  isInlinePayload,
  normalizeEventName,
  parsePayload,
  toEventRecords,
  toFailedResult,
  toPublishResult,
} from '../../src/shared/eventPublish.js';

describe('event publish', () => {
  describe('normalizeEventName', () => {
    it('leaves a bare API name alone', () => {
      assert.equal(normalizeEventName('Order_Event__e'), 'Order_Event__e');
    });

    it('strips the subscribe-style channel prefix', () => {
      assert.equal(normalizeEventName('/event/Order_Event__e'), 'Order_Event__e');
      assert.equal(normalizeEventName('/EVENT/Order_Event__e'), 'Order_Event__e');
    });

    it('trims surrounding space and stray leading slashes', () => {
      assert.equal(normalizeEventName('  /Order_Event__e '), 'Order_Event__e');
    });
  });

  describe('isInlinePayload', () => {
    it('treats JSON openers as inline payloads', () => {
      assert.equal(isInlinePayload('{"a":1}'), true);
      assert.equal(isInlinePayload('  [{"a":1}]'), true);
    });

    it('treats anything else as a file path', () => {
      assert.equal(isInlinePayload('events.json'), false);
      assert.equal(isInlinePayload('./payloads/order.json'), false);
      assert.equal(isInlinePayload(''), false);
    });
  });

  describe('parsePayload', () => {
    it('parses valid JSON', () => {
      assert.deepEqual(parsePayload('{"a":1}', 'the inline payload'), { a: 1 });
    });

    it('names the source when the JSON is malformed', () => {
      assert.throws(() => parsePayload('{oops}', 'events.json'), /Could not read events\.json as JSON/);
    });
  });

  describe('toEventRecords', () => {
    it('publishes one event for a top-level object', () => {
      assert.deepEqual(toEventRecords({ a: 1 }, 'payload'), [{ a: 1 }]);
    });

    it('publishes one event per element of a top-level array', () => {
      assert.deepEqual(toEventRecords([{ a: 1 }, { a: 2 }], 'payload'), [{ a: 1 }, { a: 2 }]);
    });

    it('rejects an empty array', () => {
      assert.throws(() => toEventRecords([], 'payload'), /no events to publish/);
    });

    it('rejects a payload that is not an object', () => {
      assert.throws(() => toEventRecords('nope', 'payload'), /payload is not a JSON object/);
      assert.throws(() => toEventRecords(null, 'payload'), /payload is not a JSON object/);
    });

    it('names the offending element when one entry of an array is not an object', () => {
      assert.throws(() => toEventRecords([{ a: 1 }, 5], 'events.json'), /Event 2 in events\.json is not a JSON object/);
    });
  });

  describe('toPublishResult', () => {
    it('reads the event UUID out of the OPERATION_ENQUEUED entry, not the placeholder id', () => {
      const result = toPublishResult(0, {
        id: 'e00xx0000000001AAA',
        success: true,
        errors: [{ statusCode: 'OPERATION_ENQUEUED', message: '4881cb6b-7aca-49b9-9d04-f2c2a6b68b07', fields: [] }],
      });

      assert.deepEqual(result, { index: 0, success: true, id: '4881cb6b-7aca-49b9-9d04-f2c2a6b68b07' });
    });

    it('falls back to the returned id when nothing was enqueued', () => {
      assert.deepEqual(toPublishResult(1, { id: '001abc', success: true, errors: [] }), {
        index: 1,
        success: true,
        id: '001abc',
      });
    });

    it('reports a failure with its status code and message', () => {
      const result = toPublishResult(2, {
        success: false,
        errors: [{ statusCode: 'INVALID_FIELD', message: "No such column 'bad__c'" }],
      });

      assert.deepEqual(result, { index: 2, success: false, errors: ["INVALID_FIELD: No such column 'bad__c'"] });
    });

    it('still reports a failure when the API gives no reason', () => {
      assert.deepEqual(toPublishResult(3, { success: false }), {
        index: 3,
        success: false,
        errors: ['Publish failed.'],
      });
    });

    it('does not treat the enqueued entry as an error on a failed publish', () => {
      const result = toPublishResult(4, {
        success: false,
        errors: [{ statusCode: 'OPERATION_ENQUEUED', message: 'uuid' }, { statusCode: 'LIMIT', message: 'too many' }],
      });

      assert.deepEqual(result.errors, ['LIMIT: too many']);
    });
  });

  describe('toFailedResult', () => {
    it('turns a thrown error into a failed result', () => {
      assert.deepEqual(toFailedResult(0, new Error('boom')), { index: 0, success: false, errors: ['boom'] });
    });

    it('copes with a thrown non-error', () => {
      assert.deepEqual(toFailedResult(0, 'boom'), { index: 0, success: false, errors: ['boom'] });
    });
  });
});
