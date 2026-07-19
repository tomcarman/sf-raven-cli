import assert from 'node:assert/strict';
import {
  buildErrorEvent,
  buildLogEvent,
  buildStatusEvent,
  serializeEvent,
} from '../../src/shared/apexLogEvents.js';

describe('apex log NDJSON events', () => {
  describe('buildLogEvent', () => {
    it('maps the notification, record, and body onto a log event', () => {
      const event = buildLogEvent(
        '07LKf000004RzfpMAC',
        '2026-07-19T10:15:30.000+0000',
        {
          Operation: 'ApexTestHandler',
          DurationMilliseconds: 123,
          Status: 'Success',
          StartTime: '2026-07-19T10:15:29.000+0000',
        },
        'line one\nline two'
      );

      assert.deepEqual(event, {
        type: 'log',
        id: '07LKf000004RzfpMAC',
        operation: 'ApexTestHandler',
        createdDate: '2026-07-19T10:15:30.000+0000',
        durationMs: 123,
        status: 'Success',
        body: 'line one\nline two',
      });
    });

    it('falls back to placeholder metadata when the log record is missing', () => {
      const event = buildLogEvent('07LKf000004RzfpMAC', '2026-07-19T10:15:30.000+0000', undefined, 'body');

      assert.equal(event.operation, 'Log');
      assert.equal(event.durationMs, 0);
      assert.equal(event.status, 'Unknown');
    });

    it('falls back to the record StartTime when the notification has no CreatedDate', () => {
      const event = buildLogEvent(
        '07LKf000004RzfpMAC',
        undefined,
        {
          Operation: 'Api',
          DurationMilliseconds: 10,
          Status: 'Success',
          StartTime: '2026-07-19T10:15:29.000+0000',
        },
        'body'
      );

      assert.equal(event.createdDate, '2026-07-19T10:15:29.000+0000');
    });

    it('serializes createdDate as an empty string when neither source has a date', () => {
      const line = serializeEvent(buildLogEvent('id', undefined, undefined, 'body'));

      assert.equal((JSON.parse(line) as { createdDate: string }).createdDate, '');
    });
  });

  describe('buildStatusEvent', () => {
    it('builds a status event with a trace expiry', () => {
      assert.deepEqual(buildStatusEvent('traceCreated', '2026-07-20T10:15:30.000Z'), {
        type: 'status',
        event: 'traceCreated',
        traceExpiry: '2026-07-20T10:15:30.000Z',
      });
    });

    it('omits traceExpiry from the serialized form when not given', () => {
      const line = serializeEvent(buildStatusEvent('connected'));

      assert.equal(line, '{"type":"status","event":"connected"}');
    });
  });

  describe('buildErrorEvent', () => {
    it('builds an error event', () => {
      assert.deepEqual(buildErrorEvent('boom'), { type: 'error', message: 'boom' });
    });
  });

  describe('serializeEvent', () => {
    it('produces a single line even when the body spans multiple lines', () => {
      const line = serializeEvent(buildLogEvent('id', 'date', undefined, 'a\nb\r\nc'));

      assert.ok(!line.includes('\n'));
      assert.ok(!line.includes('\r'));
    });

    it('round-trips through JSON.parse', () => {
      const event = buildLogEvent(
        'id',
        'date',
        { Operation: 'Op', DurationMilliseconds: 1, Status: 'Success', StartTime: 'earlier' },
        'body | with | pipes'
      );

      assert.deepEqual(JSON.parse(serializeEvent(event)), event);
    });
  });
});
