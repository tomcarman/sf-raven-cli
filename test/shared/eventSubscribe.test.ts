import assert from 'node:assert/strict';
import {
  NO_TIMEOUT_MINUTES,
  buildErrorLine,
  buildEventLine,
  buildStatusLine,
  eventSubscribeFlagError,
  resolveEventChannel,
  serializeLine,
  subscribeTimeoutMinutes,
} from '../../src/shared/eventSubscribe.js';

const receivedAt = new Date('2026-10-15T09:30:00.000Z');

describe('event subscribe', () => {
  describe('buildEventLine', () => {
    it('maps a platform event message onto an event line', () => {
      const message = {
        schema: 'XdDXhymeO5NOxuhzFpgDJA',
        payload: { Some_Event_Field__c: 'Hello World', CreatedDate: '2021-03-15T19:16:54.929Z' },
        event: { replayId: 21980379 },
      };

      assert.deepEqual(buildEventLine('/event/My_Event__e', message, receivedAt), {
        type: 'event',
        channel: '/event/My_Event__e',
        replayId: 21980379,
        receivedAt: '2026-10-15T09:30:00.000Z',
        payload: { Some_Event_Field__c: 'Hello World', CreatedDate: '2021-03-15T19:16:54.929Z' },
      });
    });

    it('keeps the ChangeEventHeader of a change event payload as is', () => {
      const payload = {
        ChangeEventHeader: {
          entityName: 'Account',
          changeType: 'UPDATE',
          recordIds: ['001xx000003DGb2AAG'],
          changedFields: ['Name'],
        },
        Name: 'Acme',
      };

      const line = buildEventLine('/data/AccountChangeEvent', { payload, event: { replayId: 5 } }, receivedAt);

      assert.deepEqual(line.payload, payload);
      assert.equal(line.replayId, 5);
    });

    it('uses a null replayId when the message has none', () => {
      assert.equal(buildEventLine('/event/X__e', { payload: {} }, receivedAt).replayId, null);
      assert.equal(buildEventLine('/event/X__e', { payload: {}, event: { replayId: '7' } }, receivedAt).replayId, null);
    });

    it('passes a message without a payload through whole', () => {
      const message = { sobject: { Id: '001' }, event: { replayId: 1 } };

      assert.deepEqual(buildEventLine('/topic/Accounts', message, receivedAt).payload, message);
    });

    it('serializes to a single line that round-trips', () => {
      const line = buildEventLine(
        '/event/X__e',
        { payload: { Body__c: 'a\nb\r\nc' }, event: { replayId: 1 } },
        receivedAt
      );
      const text = serializeLine(line);

      assert.ok(!text.includes('\n'));
      assert.ok(!text.includes('\r'));
      assert.deepEqual(JSON.parse(text), line);
    });
  });

  describe('buildStatusLine', () => {
    it('serializes connected and timeout status lines', () => {
      assert.equal(serializeLine(buildStatusLine('connected')), '{"type":"status","event":"connected"}');
      assert.equal(serializeLine(buildStatusLine('timeout')), '{"type":"status","event":"timeout"}');
    });
  });

  describe('buildErrorLine', () => {
    it('builds an error line', () => {
      assert.equal(serializeLine(buildErrorLine('boom')), '{"type":"error","message":"boom"}');
    });
  });

  describe('resolveEventChannel', () => {
    it('prefixes a bare platform event name with /event/', () => {
      assert.equal(resolveEventChannel('My_Event__e'), '/event/My_Event__e');
    });

    it('keeps a full /event/ channel as is', () => {
      assert.equal(resolveEventChannel('/event/My_Event__e'), '/event/My_Event__e');
    });

    it('maps a change event name onto /data/', () => {
      assert.equal(resolveEventChannel('AccountChangeEvent'), '/data/AccountChangeEvent');
      assert.equal(resolveEventChannel('My_Object__ChangeEvent'), '/data/My_Object__ChangeEvent');
    });

    it('keeps a full /data/ channel as is', () => {
      assert.equal(resolveEventChannel('/data/AccountChangeEvent'), '/data/AccountChangeEvent');
      assert.equal(resolveEventChannel('/data/ChangeEvents'), '/data/ChangeEvents');
    });

    it('keeps other channels that start with a slash as is', () => {
      assert.equal(resolveEventChannel('/topic/Accounts'), '/topic/Accounts');
    });

    it('trims surrounding space', () => {
      assert.equal(resolveEventChannel('  My_Event__e '), '/event/My_Event__e');
    });

    it('rejects an empty name', () => {
      assert.throws(() => resolveEventChannel('  '));
    });
  });

  describe('eventSubscribeFlagError', () => {
    it('refuses --ndjson with --json', () => {
      assert.equal(eventSubscribeFlagError({ ndjson: true, json: true, timeout: undefined }), 'error.ndjsonWithJson');
    });

    it('accepts --ndjson or --json alone', () => {
      assert.equal(eventSubscribeFlagError({ ndjson: true, json: false, timeout: undefined }), undefined);
      assert.equal(eventSubscribeFlagError({ ndjson: false, json: true, timeout: undefined }), undefined);
    });

    it('refuses a terminal-mode timeout over 30 minutes', () => {
      assert.equal(eventSubscribeFlagError({ ndjson: false, json: false, timeout: 30 }), undefined);
      assert.equal(eventSubscribeFlagError({ ndjson: false, json: false, timeout: 31 }), 'error.timeoutTooLong');
      assert.equal(eventSubscribeFlagError({ ndjson: false, json: true, timeout: 31 }), 'error.timeoutTooLong');
    });

    it('allows a timeout over 30 minutes with --ndjson', () => {
      assert.equal(eventSubscribeFlagError({ ndjson: true, json: false, timeout: 240 }), undefined);
    });
  });

  describe('subscribeTimeoutMinutes', () => {
    it('defaults to 3 minutes in terminal mode', () => {
      assert.equal(subscribeTimeoutMinutes(undefined, false), 3);
    });

    it('uses the given timeout in terminal mode', () => {
      assert.equal(subscribeTimeoutMinutes(10, false), 10);
    });

    it('has no timeout in ndjson mode unless one is given', () => {
      assert.equal(subscribeTimeoutMinutes(undefined, true), NO_TIMEOUT_MINUTES);
    });

    it('uses the given timeout in ndjson mode, past 30 minutes', () => {
      assert.equal(subscribeTimeoutMinutes(5, true), 5);
      assert.equal(subscribeTimeoutMinutes(240, true), 240);
    });

    it('caps ndjson timeouts so the timer cannot overflow', () => {
      assert.equal(subscribeTimeoutMinutes(10_000_000, true), NO_TIMEOUT_MINUTES);
      assert.ok(NO_TIMEOUT_MINUTES * 60 * 1000 < 2 ** 31 - 1);
    });
  });
});
