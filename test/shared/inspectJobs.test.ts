import assert from 'node:assert/strict';
import {
  buildAsyncJobsQuery,
  decodeJobType,
  formatErrors,
  formatProgress,
  formatSubmitted,
  parseSince,
  toAsyncJob,
  type AsyncApexJobRecord,
} from '../../src/shared/inspectJobs.js';
import { stripAnsi } from '../../src/shared/table.js';

const record = (overrides: Partial<AsyncApexJobRecord> = {}): AsyncApexJobRecord => ({
  Id: '707aj0000166yKHAAY',
  JobType: 'BatchApex',
  Status: 'Processing',
  MethodName: null,
  JobItemsProcessed: 3,
  TotalJobItems: 10,
  NumberOfErrors: 0,
  ExtendedStatus: null,
  CreatedDate: '2026-07-28T09:14:00.000+0000',
  CompletedDate: null,
  ApexClass: { Name: 'AccountBackfill' },
  CreatedBy: { Name: 'Tom Carman' },
  ...overrides,
});

describe('inspect jobs', () => {
  describe('parseSince', () => {
    it('reads minutes, hours, and days', () => {
      assert.equal(parseSince('90m'), 90 * 60_000);
      assert.equal(parseSince('2h'), 2 * 3_600_000);
      assert.equal(parseSince('3d'), 3 * 86_400_000);
    });

    it('is case-insensitive and tolerates surrounding space', () => {
      assert.equal(parseSince(' 2H '), 2 * 3_600_000);
    });

    it('rejects anything else', () => {
      for (const value of ['', '2', 'h', '2w', '2 h', '-2h', '1.5h', 'twoh']) {
        assert.equal(parseSince(value), undefined, value);
      }
    });

    it('rejects a zero window, which would show nothing finished', () => {
      assert.equal(parseSince('0h'), undefined);
    });
  });

  describe('buildAsyncJobsQuery', () => {
    const query = buildAsyncJobsQuery(new Date('2026-07-27T09:00:00.000Z'), 50);

    it('always includes in-flight jobs regardless of the window', () => {
      assert.equal(query.includes("WHERE Status IN ('Holding', 'Queued', 'Preparing', 'Processing')"), true);
    });

    it('bounds finished jobs by CreatedDate, which every job type populates', () => {
      assert.equal(
        query.includes("OR (Status IN ('Completed', 'Failed', 'Aborted') AND CreatedDate >= 2026-07-27T09:00:00.000Z)"),
        true
      );
      assert.equal(query.includes('CompletedDate >='), false);
    });

    it('orders newest first and applies the row cap', () => {
      assert.equal(query.includes('ORDER BY CreatedDate DESC LIMIT 50'), true);
    });

    it('selects CompletedDate for the JSON output', () => {
      assert.equal(query.includes('CompletedDate'), true);
    });
  });

  describe('decodeJobType', () => {
    it('spells out the known job types', () => {
      assert.equal(decodeJobType('BatchApex'), 'Batch Apex');
      assert.equal(decodeJobType('ScheduledApex'), 'Scheduled Apex');
      assert.equal(decodeJobType('Queueable'), 'Queueable');
      assert.equal(decodeJobType('TestRequest'), 'Test Request');
    });

    it('passes an unrecognised type through unchanged', () => {
      assert.equal(decodeJobType('SomethingNew'), 'SomethingNew');
    });
  });

  describe('toAsyncJob', () => {
    it('maps the record onto the row', () => {
      const job = toAsyncJob(record());

      assert.equal(job.id, '707aj0000166yKHAAY');
      assert.equal(job.type, 'Batch Apex');
      assert.equal(job.apexClass, 'AccountBackfill');
      assert.equal(job.createdBy, 'Tom Carman');
      assert.equal(job.errors, 0);
    });

    it('appends the method name for futures', () => {
      const job = toAsyncJob(record({ JobType: 'Future', MethodName: 'syncLater' }));

      assert.equal(job.apexClass, 'AccountBackfill.syncLater');
    });

    it('does not append the method name for non-futures', () => {
      const job = toAsyncJob(record({ JobType: 'Queueable', MethodName: 'execute' }));

      assert.equal(job.apexClass, 'AccountBackfill');
    });

    it('survives a missing class, creator, and error count', () => {
      const job = toAsyncJob(record({ ApexClass: null, CreatedBy: null, NumberOfErrors: null }));

      assert.equal(job.apexClass, '');
      assert.equal(job.createdBy, '');
      assert.equal(job.errors, 0);
    });
  });

  describe('formatProgress', () => {
    it('shows processed over total for batch jobs', () => {
      assert.equal(formatProgress(toAsyncJob(record())), '3/10');
      assert.equal(formatProgress(toAsyncJob(record({ JobType: 'BatchApexWorker' }))), '3/10');
    });

    it('is blank for job types where the item count means nothing', () => {
      assert.equal(formatProgress(toAsyncJob(record({ JobType: 'Queueable', TotalJobItems: 1 }))), '');
      assert.equal(formatProgress(toAsyncJob(record({ JobType: 'Future' }))), '');
    });

    it('is blank for a batch job with no items yet', () => {
      assert.equal(formatProgress(toAsyncJob(record({ TotalJobItems: 0 }))), '');
    });
  });

  describe('formatSubmitted', () => {
    const now = new Date('2026-07-28T12:00:00.000Z');

    it('shows the time only for jobs submitted today', () => {
      const rendered = stripAnsi(formatSubmitted('2026-07-28T09:14:00.000Z', 'Tom Carman', now));

      assert.equal(/^\d{2}:\d{2} Tom Carman$/.test(rendered), true, rendered);
    });

    it('adds the date for older jobs', () => {
      const rendered = stripAnsi(formatSubmitted('2026-07-25T09:14:00.000Z', 'Tom Carman', now));

      assert.equal(rendered.startsWith('2026-07-25 '), true, rendered);
    });

    it('omits the trailing name when the creator is unknown', () => {
      const rendered = stripAnsi(formatSubmitted('2026-07-28T09:14:00.000Z', '', now));

      assert.equal(/^\d{2}:\d{2}$/.test(rendered), true, rendered);
    });
  });

  describe('formatErrors', () => {
    it('is blank when there are none', () => {
      assert.equal(formatErrors(0), '');
    });

    it('shows the count when there are some', () => {
      assert.equal(stripAnsi(formatErrors(4)), '4');
    });
  });
});
