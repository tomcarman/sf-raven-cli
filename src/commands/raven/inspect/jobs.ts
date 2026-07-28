import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import chalk from 'chalk';
import {
  buildAsyncJobsQuery,
  formatErrors,
  formatProgress,
  formatStatus,
  formatSubmitted,
  parseSince,
  toAsyncJob,
  type AsyncApexJobRecord,
  type AsyncJob,
} from '../../../shared/inspectJobs.js';
import { renderTable, type TableColumn } from '../../../shared/table.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.inspect.jobs');

const defaultSince = '24h';

export type InspectJobsResult = {
  asyncJobs: AsyncJob[];
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
    const asyncJobs = await this.queryAsyncJobs(flags['target-org'].getConnection(), sinceMs, flags.limit, now);

    ux.log(`\n${chalk.bold(messages.getMessage('label.asyncJobs'))} ${chalk.dim(`(${asyncJobs.length})`)}\n`);

    if (asyncJobs.length === 0) {
      ux.log(messages.getMessage('info.noAsyncJobs', [flags.since]));
    } else {
      for (const line of renderTable(asyncJobs, asyncJobColumns(now), { note: extendedStatusNote })) {
        ux.log(line);
      }
    }

    return { asyncJobs };
  }

  private async queryAsyncJobs(
    connection: Connection,
    sinceMs: number,
    limit: number,
    now: Date
  ): Promise<AsyncJob[]> {
    this.spinner.start(messages.getMessage('info.loading'));

    try {
      const query = buildAsyncJobsQuery(new Date(now.getTime() - sinceMs), limit);
      const result = await connection.query<AsyncApexJobRecord>(query);

      return result.records.map(toAsyncJob);
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
