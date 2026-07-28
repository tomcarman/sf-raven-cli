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
 * OpportunityFieldHistory, Invoice__History), so the history child and its
 * lookup back to the parent are discovered from describe rather than hardcoded.
 *
 * Only a child named after this object is accepted. Nearly every object carries
 * unrelated `*History` children - ActivityHistory, ProcessInstanceHistory,
 * RecordActionHistory - and objects that do not track field history carry
 * nothing else, so taking "the only History child" picks an object with no
 * Field/OldValue/NewValue columns and fails with a raw SOQL error. Reporting
 * that tracking is off is the better answer.
 *
 * FieldHistory ranks above History because objects that have both - Opportunity
 * among them - keep field-level changes in the FieldHistory object and use the
 * plain History object for something else entirely.
 */
export const findHistoryRelationship = (
  sobject: string,
  childRelationships: readonly ChildRelationship[]
): HistoryRelationship | undefined => {
  const byLowerName = new Map(
    childRelationships
      .filter((relationship) => relationship.field.length > 0)
      .map((relationship) => [relationship.childSObject.toLowerCase(), relationship])
  );

  for (const name of expectedHistoryNames(sobject)) {
    const match = byLowerName.get(name.toLowerCase());

    if (match != null) {
      return { object: match.childSObject, field: match.field };
    }
  }

  return undefined;
};

const expectedHistoryNames = (sobject: string): string[] => {
  const base = sobject.replace(/__c$/i, '');

  return [`${sobject}FieldHistory`, `${sobject}History`, `${base}__History`];
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
