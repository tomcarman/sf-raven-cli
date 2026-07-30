import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import chalk from 'chalk';
import cronstrue from 'cronstrue';
import {
  buildAsyncJobsQuery,
  compareByNextRun,
  formatErrors,
  formatFireTime,
  formatProgress,
  formatScheduledName,
  formatStatus,
  formatSubmitted,
  parseSince,
  scheduledJobsQuery,
  toAsyncJob,
  toScheduledJob,
  type AsyncApexJobRecord,
  type AsyncJob,
  type CronTriggerRecord,
  type ScheduledJob,
} from '../../../shared/inspectJobs.js';
import { renderTable, type TableColumn } from '../../../shared/table.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.inspect.jobs');

const defaultSince = '24h';

export type InspectJobsResult = {
  asyncJobs: AsyncJob[];
  scheduledJobs: ScheduledJob[];
};

export default class InspectJobs extends SfCommand<InspectJobsResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
    }),
    since: Flags.string({
      summary: messages.getMessage('flags.since.summary'),
      default: defaultSince,
    }),
    limit: Flags.integer({
      summary: messages.getMessage('flags.limit.summary'),
      min: 1,
      default: 50,
    }),
  };

  public async run(): Promise<InspectJobsResult> {
    const { flags } = await this.parse(InspectJobs);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    const sinceMs = parseSince(flags.since);

    if (sinceMs == null) {
      throw messages.createError('error.badSince', [flags.since]);
    }

    const now = new Date();
    const connection = flags['target-org'].getConnection();
    const { asyncJobs, scheduledJobs } = await this.queryJobs(connection, sinceMs, flags.limit, now);

    ux.log(`\n${chalk.bold(messages.getMessage('label.asyncJobs'))} ${chalk.dim(`(${asyncJobs.length})`)}\n`);

    if (asyncJobs.length === 0) {
      ux.log(messages.getMessage('info.noAsyncJobs', [flags.since]));
    } else {
      for (const line of renderTable(asyncJobs, asyncJobColumns(now), { note: extendedStatusNote })) {
        ux.log(line);
      }
    }

    ux.log(`\n${chalk.bold(messages.getMessage('label.scheduledJobs'))} ${chalk.dim(`(${scheduledJobs.length})`)}\n`);

    if (scheduledJobs.length === 0) {
      ux.log(messages.getMessage('info.noScheduledJobs'));
    } else {
      for (const line of renderTable(scheduledJobs, scheduledJobColumns)) {
        ux.log(line);
      }
    }

    return { asyncJobs, scheduledJobs };
  }

  private async queryJobs(
    connection: Connection,
    sinceMs: number,
    limit: number,
    now: Date
  ): Promise<InspectJobsResult> {
    this.spinner.start(messages.getMessage('info.loading'));

    try {
      const [async, scheduled] = await Promise.all([
        connection.query<AsyncApexJobRecord>(buildAsyncJobsQuery(new Date(now.getTime() - sinceMs), limit)),
        connection.query<CronTriggerRecord>(scheduledJobsQuery),
      ]);

      return {
        asyncJobs: async.records.map(toAsyncJob),
        scheduledJobs: scheduled.records
          .map((record) => toScheduledJob(record, describeSchedule))
          .sort(compareByNextRun),
      };
    } finally {
      this.spinner.stop();
    }
  }
}

/** Only failures carry an explanation worth the extra line. */
const extendedStatusNote = (job: AsyncJob): string | undefined =>
  job.status === 'Failed' && job.extendedStatus != null ? job.extendedStatus : undefined;

const asyncJobColumns = (now: Date): Array<TableColumn<AsyncJob>> => [
  { header: 'Type', get: (job) => job.type },
  { header: 'Apex Class', get: (job) => job.apexClass },
  { header: 'Status', get: (job) => formatStatus(job.status) },
  { header: 'Progress', get: formatProgress },
  { header: 'Errors', get: (job) => formatErrors(job.errors) },
  { header: 'Submitted', get: (job) => formatSubmitted(job.createdDate, job.createdBy, now) },
  { header: 'Job Id', get: (job) => job.id },
];

/** Salesforce uses Quartz cron, which carries a leading seconds field. */
const describeSchedule = (cronExpression: string | null): string => {
  if (cronExpression == null || cronExpression.trim().length === 0) {
    return '';
  }

  try {
    return cronstrue.toString(cronExpression, { verbose: false, use24HourTimeFormat: true });
  } catch {
    return cronExpression;
  }
};

const scheduledJobColumns: Array<TableColumn<ScheduledJob>> = [
  { header: 'Type', get: (job) => job.type },
  { header: 'Name', get: formatScheduledName },
  { header: 'Schedule', get: (job) => job.schedule },
  { header: 'Next Run', get: (job) => formatFireTime(job.nextRun) },
  { header: 'Last Run', get: (job) => formatFireTime(job.lastRun) },
  { header: 'Job Id', get: (job) => job.id },
];
