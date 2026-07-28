import dayjs from 'dayjs';
import { escapeSoqlString } from './query.js';

export type RecentDescribeField = {
  name: string;
  nameField?: boolean;
};

export type RecentRecordTypeInfo = {
  master?: boolean;
};

export type RecentDescribe = {
  fields: RecentDescribeField[];
  recordTypeInfos?: RecentRecordTypeInfo[];
};

export const createdSortField = 'CreatedDate';
export const modifiedSortField = 'LastModifiedDate';

export const findNameField = (fields: readonly RecentDescribeField[]): string | undefined =>
  fields.find((field) => field.nameField === true)?.name;

export const hasField = (fields: readonly RecentDescribeField[], name: string): boolean =>
  fields.some((field) => field.name.toLowerCase() === name.toLowerCase());

/**
 * Every object has a Master record type entry, so anything beyond that is what
 * makes --recordtype meaningful.
 */
export const hasRecordTypes = (describe: RecentDescribe): boolean =>
  (describe.recordTypeInfos ?? []).some((info) => info.master !== true);

/**
 * A minimal floor: who made it, when, and enough to recognise it. The name
 * column drops out for objects describe gives no name field for.
 */
export const defaultFields = (nameField: string | undefined, modified: boolean): string[] => [
  'Id',
  ...(nameField == null ? [] : [nameField]),
  ...(modified ? [modifiedSortField, 'LastModifiedBy.Username'] : [createdSortField, 'CreatedBy.Username']),
];

/**
 * -f is additive here, unlike `query record` where it replaces: recent's
 * defaults are a floor worth keeping, not a full field dump to swap out.
 */
export const mergeFields = (defaults: readonly string[], extra: string | undefined): string[] => {
  const merged = [...defaults];
  const seen = new Set(defaults.map((field) => field.toLowerCase()));

  for (const field of (extra ?? '').split(',').map((value) => value.trim())) {
    if (field.length > 0 && !seen.has(field.toLowerCase())) {
      seen.add(field.toLowerCase());
      merged.push(field);
    }
  }

  return merged;
};

export type RecentQueryOptions = {
  sobject: string;
  fields: readonly string[];
  sortField: string;
  limit: number;
  recordType?: string;
};

export const buildRecentQuery = (options: RecentQueryOptions): string => {
  const where =
    options.recordType == null
      ? ''
      : ` WHERE RecordType.DeveloperName = '${escapeSoqlString(options.recordType)}'`;

  return `SELECT ${options.fields.join(', ')} FROM ${options.sobject}${where} ORDER BY ${options.sortField} DESC LIMIT ${options.limit}`;
};

const minute = 60;
const hour = minute * 60;
const day = hour * 24;
const month = day * 30;
const year = day * 365;

/** Coarse and readable - "2h ago" beats "2 hours and 14 minutes ago" in a table. */
export const formatRelativeAge = (isoDate: string, now: Date = new Date()): string => {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(isoDate).getTime()) / 1000));

  if (seconds < minute) {
    return 'just now';
  }

  if (seconds < hour) {
    return `${Math.floor(seconds / minute)}m ago`;
  }

  if (seconds < day) {
    return `${Math.floor(seconds / hour)}h ago`;
  }

  if (seconds < month) {
    return `${Math.floor(seconds / day)}d ago`;
  }

  if (seconds < year) {
    return `${Math.floor(seconds / month)}mo ago`;
  }

  return `${Math.floor(seconds / year)}y ago`;
};

export const formatSortDate = (value: unknown, now: Date = new Date()): string => {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  return `${dayjs(value).format('YYYY-MM-DD HH:mm')} (${formatRelativeAge(value, now)})`;
};
