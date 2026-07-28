import dayjs from 'dayjs';
import { escapeSoqlString } from './query.js';

export type ChildRelationship = {
  childSObject: string;
  field: string;
};

export type HistoryRelationship = {
  /** The history object, e.g. AccountHistory or Invoice__History. */
  object: string;
  /** The lookup on the history object back to the parent record. */
  field: string;
};

export type HistoryRecord = {
  Field: string;
  OldValue: unknown;
  NewValue: unknown;
  CreatedDate: string;
  CreatedBy?: { Username?: string } | null;
} & Record<string, unknown>;

export type HistoryRow = {
  date: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string;
  /** True for lifecycle events (created, ownerAssignment, ...) with no values. */
  isEvent: boolean;
};

const shortIdLength = 15;

/**
 * Salesforce names history objects inconsistently (AccountHistory,
 * OpportunityFieldHistory, Invoice__History), so the child relationship is
 * discovered from describe rather than guessed. The names derived from this
 * object rank first so an unrelated *History child cannot win.
 */
export const findHistoryRelationship = (
  sobject: string,
  childRelationships: readonly ChildRelationship[]
): HistoryRelationship | undefined => {
  const candidates = childRelationships.filter(
    (relationship) => relationship.childSObject.toLowerCase().endsWith('history') && relationship.field.length > 0
  );

  if (candidates.length === 0) {
    return undefined;
  }

  const expected = expectedHistoryNames(sobject).map((name) => name.toLowerCase());

  for (const name of expected) {
    const match = candidates.find((candidate) => candidate.childSObject.toLowerCase() === name);

    if (match != null) {
      return { object: match.childSObject, field: match.field };
    }
  }

  // No name derived from this object matched. A single candidate is still
  // unambiguous; several would be a guess, so decline rather than guess wrong.
  return candidates.length === 1 ? { object: candidates[0].childSObject, field: candidates[0].field } : undefined;
};

const expectedHistoryNames = (sobject: string): string[] => {
  const base = sobject.replace(/__c$/i, '');

  return [`${sobject}History`, `${sobject}FieldHistory`, `${base}__History`];
};

export const buildHistoryQuery = (relationship: HistoryRelationship, recordIds: readonly string[]): string => {
  const ids = recordIds.map((id) => `'${escapeSoqlString(id)}'`).join(', ');

  return [
    `SELECT ${relationship.field}, Field, OldValue, NewValue, CreatedDate, CreatedBy.Username`,
    `FROM ${relationship.object}`,
    `WHERE ${relationship.field} IN (${ids})`,
    'ORDER BY CreatedDate DESC',
  ].join(' ');
};

/**
 * Lifecycle rows carry no old or new value - the field name is the event. They
 * are labelled rather than left as a mystery row with two empty cells.
 */
const eventLabels: Readonly<Record<string, string>> = {
  created: 'Record created',
  ownerAssignment: 'Owner assigned',
  accountMerged: 'Account merged',
  feedEvent: 'Feed event',
  locked: 'Record locked',
  unlocked: 'Record unlocked',
  personAccountMerged: 'Person account merged',
};

export const isEventField = (record: HistoryRecord): boolean =>
  record.OldValue == null && record.NewValue == null && Object.hasOwn(eventLabels, record.Field);

export const eventLabel = (field: string): string => eventLabels[field] ?? field;

export const toHistoryRow = (record: HistoryRecord): HistoryRow => {
  const isEvent = isEventField(record);

  return {
    date: record.CreatedDate,
    field: isEvent ? eventLabel(record.Field) : record.Field,
    oldValue: record.OldValue,
    newValue: record.NewValue,
    changedBy: record.CreatedBy?.Username ?? '',
    isEvent,
  };
};

/** Ids come back 18 characters long however they were asked for. */
export const groupHistoryByRecord = (
  records: readonly HistoryRecord[],
  parentField: string,
  recordIds: readonly string[]
): Record<string, HistoryRow[]> => {
  const byShortId = new Map(recordIds.map((id) => [id.slice(0, shortIdLength), id]));
  const grouped: Record<string, HistoryRow[]> = Object.fromEntries(recordIds.map((id) => [id, []]));

  for (const record of records) {
    const parentId = String(record[parentField] ?? '').slice(0, shortIdLength);
    const requestedId = byShortId.get(parentId);

    if (requestedId != null) {
      grouped[requestedId].push(toHistoryRow(record));
    }
  }

  return grouped;
};

export const formatHistoryDate = (isoDate: string): string => dayjs(isoDate).format('YYYY-MM-DD HH:mm:ss');

/** Event rows have no values to show, so the cells say so rather than sitting blank. */
export const formatHistoryValue = (value: unknown, isEvent: boolean): string => {
  if (isEvent) {
    return '-';
  }

  if (value == null) {
    return '';
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
};
