import assert from 'node:assert/strict';
import cronstrue from 'cronstrue';
import {
  buildAsyncJobsQuery,
  compareByNextRun,
  decodeCronJobType,
  decodeJobType,
  formatFireTime,
  formatScheduledName,
  toScheduledJob,
  type CronTriggerRecord,
  type ScheduledJob,
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

  describe('scheduled jobs', () => {
    const describeSchedule = (expression: string | null): string =>
      expression == null ? '' : cronstrue.toString(expression, { use24HourTimeFormat: true });

    const cronRecord = (overrides: Partial<CronTriggerRecord> = {}): CronTriggerRecord => ({
      Id: '08eaj000000abcAAA',
      CronExpression: '0 0 3 * * ?',
      State: 'WAITING',
      NextFireTime: '2026-07-29T03:00:00.000+0000',
      PreviousFireTime: '2026-07-28T03:00:00.000+0000',
      StartTime: '2026-01-01T00:00:00.000+0000',
      EndTime: null,
      TimesTriggered: 12,
      CronJobDetail: { Name: 'Nightly Sync', JobType: '7' },
      ...overrides,
    });

    const scheduled = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
      ...toScheduledJob(cronRecord(), describeSchedule),
      ...overrides,
    });

    describe('decodeCronJobType', () => {
      it('spells out the documented codes', () => {
        assert.equal(decodeCronJobType('7'), 'Scheduled Apex');
        assert.equal(decodeCronJobType('9'), 'Batch Job');
        assert.equal(decodeCronJobType('8'), 'Report Run');
        assert.equal(decodeCronJobType('A'), 'Reporting Notification');
      });

      it('passes an unknown code through and treats a missing one as blank', () => {
        assert.equal(decodeCronJobType('Z'), 'Z');
        assert.equal(decodeCronJobType(null), '');
      });
    });

    describe('toScheduledJob', () => {
      it('maps the trigger and its detail onto the row', () => {
        const job = toScheduledJob(cronRecord(), describeSchedule);

        assert.equal(job.id, '08eaj000000abcAAA');
        assert.equal(job.name, 'Nightly Sync');
        assert.equal(job.type, 'Scheduled Apex');
        assert.equal(job.schedule.toLowerCase().includes('03:00'), true, job.schedule);
      });

      it('keeps the raw cron expression, state, counters, and window for JSON', () => {
        const job = toScheduledJob(cronRecord(), describeSchedule);

        assert.equal(job.cronExpression, '0 0 3 * * ?');
        assert.equal(job.state, 'WAITING');
        assert.equal(job.timesTriggered, 12);
        assert.equal(job.startTime, '2026-01-01T00:00:00.000+0000');
        assert.equal(job.endTime, null);
      });

      it('survives a missing CronJobDetail', () => {
        const job = toScheduledJob(cronRecord({ CronJobDetail: null }), describeSchedule);

        assert.equal(job.name, '');
        assert.equal(job.type, '');
      });
    });

    describe('compareByNextRun', () => {
      it('puts the soonest next run first', () => {
        const order = [
          scheduled({ name: 'later', nextRun: '2026-07-30T03:00:00.000+0000' }),
          scheduled({ name: 'sooner', nextRun: '2026-07-29T03:00:00.000+0000' }),
        ]
          .sort(compareByNextRun)
          .map((job) => job.name);

        assert.deepEqual(order, ['sooner', 'later']);
      });

      it('sinks jobs with no next fire time to the bottom', () => {
        const order = [
          scheduled({ name: 'deleted', nextRun: null }),
          scheduled({ name: 'waiting', nextRun: '2026-07-29T03:00:00.000+0000' }),
        ]
          .sort(compareByNextRun)
          .map((job) => job.name);

        assert.deepEqual(order, ['waiting', 'deleted']);
      });

      it('falls back to name order for ties and for jobs that never fire again', () => {
        const sameTime = '2026-07-29T03:00:00.000+0000';
        const order = [
          scheduled({ name: 'b', nextRun: sameTime }),
          scheduled({ name: 'a', nextRun: sameTime }),
          scheduled({ name: 'z', nextRun: null }),
          scheduled({ name: 'y', nextRun: null }),
        ]
          .sort(compareByNextRun)
          .map((job) => job.name);

        assert.deepEqual(order, ['a', 'b', 'y', 'z']);
      });
    });

    describe('formatFireTime', () => {
      it('renders a timestamp and leaves a missing one blank', () => {
        assert.equal(formatFireTime(null), '');
        assert.equal(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(formatFireTime('2026-07-29T03:00:00.000Z')), true);
      });
    });

    describe('formatScheduledName', () => {
      it('leaves a waiting job unmarked', () => {
        assert.equal(formatScheduledName(scheduled({ name: 'Nightly', state: 'WAITING' })), 'Nightly');
      });

      it('marks any other state on the row', () => {
        assert.equal(
          stripAnsi(formatScheduledName(scheduled({ name: 'Nightly', state: 'PAUSED' }))),
          'Nightly [PAUSED]'
        );
      });
    });

    it('renders Salesforce Quartz expressions, including the seconds field', () => {
      assert.equal(describeSchedule('0 0 3 * * ?').includes('03:00'), true);
      assert.equal(describeSchedule('0 30 2 ? * MON-FRI').toLowerCase().includes('monday'), true);
    });
  });
});
