import chalk from 'chalk';
import dayjs from 'dayjs';
import { escapeSoqlString } from './query.js';

export type AsyncApexJobRecord = {
  Id: string;
  JobType: string;
  Status: string;
  MethodName: string | null;
  JobItemsProcessed: number | null;
  TotalJobItems: number | null;
  NumberOfErrors: number | null;
  ExtendedStatus: string | null;
  CreatedDate: string;
  CompletedDate: string | null;
  ApexClass: { Name: string } | null;
  CreatedBy: { Name: string } | null;
};

export type AsyncJob = {
  id: string;
  type: string;
  jobType: string;
  apexClass: string;
  status: string;
  itemsProcessed: number | null;
  totalItems: number | null;
  errors: number;
  extendedStatus: string | null;
  createdDate: string;
  completedDate: string | null;
  createdBy: string;
};

export const inFlightStatuses = ['Holding', 'Queued', 'Preparing', 'Processing'] as const;
export const finishedStatuses = ['Completed', 'Failed', 'Aborted'] as const;

const jobTypeLabels: Readonly<Record<string, string>> = {
  BatchApex: 'Batch Apex',
  BatchApexWorker: 'Batch Apex (chunk)',
  Future: 'Future',
  Queueable: 'Queueable',
  ScheduledApex: 'Scheduled Apex',
  SharingRecalculation: 'Sharing Recalculation',
  ApexToken: 'Apex Token',
  TestRequest: 'Test Request',
  TestWorker: 'Test Worker',
};

const batchJobTypes = new Set(['BatchApex', 'BatchApexWorker']);

export const decodeJobType = (jobType: string): string => jobTypeLabels[jobType] ?? jobType;

const durationPattern = /^(\d+)([mhd])$/i;

const durationMultipliers: Readonly<Record<string, number>> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses a `--since` value such as `90m`, `2h`, or `3d` into milliseconds. */
export const parseSince = (value: string): number | undefined => {
  const match = durationPattern.exec(value.trim());

  if (match == null) {
    return undefined;
  }

  const amount = Number(match[1]);

  return amount === 0 ? undefined : amount * durationMultipliers[match[2].toLowerCase()];
};

/**
 * The finished-job window filters on CreatedDate rather than CompletedDate:
 * some job types (TestRequest among them) never populate CompletedDate, so a
 * CompletedDate filter silently drops them.
 */
export const buildAsyncJobsQuery = (finishedSince: Date, limit: number): string => {
  const inFlight = toSoqlList(inFlightStatuses);
  const finished = toSoqlList(finishedStatuses);

  return [
    'SELECT Id, JobType, Status, MethodName, JobItemsProcessed, TotalJobItems, NumberOfErrors,',
    'ExtendedStatus, CreatedDate, CompletedDate, ApexClass.Name, CreatedBy.Name',
    'FROM AsyncApexJob',
    `WHERE Status IN (${inFlight})`,
    `OR (Status IN (${finished}) AND CreatedDate >= ${finishedSince.toISOString()})`,
    'ORDER BY CreatedDate DESC',
    `LIMIT ${limit}`,
  ].join(' ');
};

export const toAsyncJob = (record: AsyncApexJobRecord): AsyncJob => ({
  id: record.Id,
  type: decodeJobType(record.JobType),
  jobType: record.JobType,
  apexClass: formatApexClass(record),
  status: record.Status,
  itemsProcessed: record.JobItemsProcessed,
  totalItems: record.TotalJobItems,
  errors: record.NumberOfErrors ?? 0,
  extendedStatus: record.ExtendedStatus,
  createdDate: record.CreatedDate,
  completedDate: record.CompletedDate,
  createdBy: record.CreatedBy?.Name ?? '',
});

/** Futures are only identifiable by method, so the method is part of the name. */
const formatApexClass = (record: AsyncApexJobRecord): string => {
  const className = record.ApexClass?.Name ?? '';

  if (record.JobType !== 'Future' || record.MethodName == null) {
    return className;
  }

  return className.length === 0 ? record.MethodName : `${className}.${record.MethodName}`;
};

/** Batch progress only; other job types have no meaningful item count. */
export const formatProgress = (job: AsyncJob): string =>
  batchJobTypes.has(job.jobType) && job.totalItems != null && job.totalItems > 0
    ? `${job.itemsProcessed ?? 0}/${job.totalItems}`
    : '';

/** Same-day jobs show the time only; older ones carry the date too. */
export const formatSubmitted = (isoDate: string, createdBy: string, now: Date = new Date()): string => {
  const submitted = dayjs(isoDate);
  const time = submitted.isSame(dayjs(now), 'day') ? submitted.format('HH:mm') : submitted.format('YYYY-MM-DD HH:mm');

  return createdBy.length === 0 ? time : `${time} ${chalk.dim(createdBy)}`;
};

export const formatStatus = (status: string): string => {
  switch (status) {
    case 'Failed':
      return chalk.red(status);
    case 'Aborted':
      return chalk.yellow(status);
    case 'Completed':
      return chalk.green(status);
    default:
      return status;
  }
};

export const formatErrors = (errors: number): string => (errors > 0 ? chalk.red(String(errors)) : '');

export type CronTriggerRecord = {
  Id: string;
  CronExpression: string | null;
  State: string;
  NextFireTime: string | null;
  PreviousFireTime: string | null;
  StartTime: string | null;
  EndTime: string | null;
  TimesTriggered: number | null;
  CronJobDetail: { Name: string; JobType: string } | null;
};

export type ScheduledJob = {
  id: string;
  type: string;
  cronJobType: string;
  name: string;
  schedule: string;
  cronExpression: string | null;
  state: string;
  nextRun: string | null;
  lastRun: string | null;
  startTime: string | null;
  endTime: string | null;
  timesTriggered: number | null;
};

/**
 * CronJobDetail.JobType is a picklist of opaque codes. Labels taken from the
 * object's own describe; anything unlisted passes through as the raw code.
 */
const cronJobTypeLabels: Readonly<Record<string, string>> = {
  '1': 'Data Export',
  '3': 'Dashboard Refresh',
  '4': 'Reporting Snapshot',
  '6': 'Scheduled Flow',
  '7': 'Scheduled Apex',
  '8': 'Report Run',
  '9': 'Batch Job',
  A: 'Reporting Notification',
};

export const decodeCronJobType = (jobType: string | null | undefined): string =>
  jobType == null ? '' : cronJobTypeLabels[jobType] ?? jobType;

export const scheduledJobsQuery = [
  'SELECT Id, CronExpression, State, NextFireTime, PreviousFireTime, StartTime, EndTime, TimesTriggered,',
  'CronJobDetail.Name, CronJobDetail.JobType',
  'FROM CronTrigger',
].join(' ');

export const toScheduledJob = (record: CronTriggerRecord, describeSchedule: ScheduleDescriber): ScheduledJob => ({
  id: record.Id,
  type: decodeCronJobType(record.CronJobDetail?.JobType),
  cronJobType: record.CronJobDetail?.JobType ?? '',
  name: record.CronJobDetail?.Name ?? '',
  schedule: describeSchedule(record.CronExpression),
  cronExpression: record.CronExpression,
  state: record.State,
  nextRun: record.NextFireTime,
  lastRun: record.PreviousFireTime,
  startTime: record.StartTime,
  endTime: record.EndTime,
  timesTriggered: record.TimesTriggered,
});

export type ScheduleDescriber = (cronExpression: string | null) => string;

/** Soonest first; jobs that will never fire again sink to the bottom. */
export const compareByNextRun = (left: ScheduledJob, right: ScheduledJob): number => {
  if (left.nextRun == null && right.nextRun == null) {
    return left.name.localeCompare(right.name);
  }

  if (left.nextRun == null) {
    return 1;
  }

  if (right.nextRun == null) {
    return -1;
  }

  return left.nextRun.localeCompare(right.nextRun) || left.name.localeCompare(right.name);
};

export const formatFireTime = (isoDate: string | null): string =>
  isoDate == null ? '' : dayjs(isoDate).format('YYYY-MM-DD HH:mm');

/**
 * State is WAITING for virtually every row, so it earns a column only when it
 * is not - and then as a marker on the row it affects.
 */
export const formatScheduledName = (job: ScheduledJob): string =>
  job.state === 'WAITING' ? job.name : `${job.name} ${chalk.yellow(`[${job.state}]`)}`;

const toSoqlList = (values: readonly string[]): string =>
  values.map((value) => `'${escapeSoqlString(value)}'`).join(', ');
