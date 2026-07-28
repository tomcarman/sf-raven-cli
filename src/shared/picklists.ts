export type DescribePicklistValue = {
  value: string;
  label: string | null;
  active: boolean;
  defaultValue: boolean;
};

export type DescribeFieldWithPicklist = {
  name: string;
  label: string;
  type: string;
  controllerName?: string | null;
  picklistValues?: DescribePicklistValue[];
};

export type PicklistValue = {
  value: string;
  label: string;
  isDefault: boolean;
  /** Present only for objects with record types; keyed by developer name. */
  availability?: Record<string, boolean>;
  /** Record types this value is the default for, keyed by developer name. */
  defaultFor?: Record<string, boolean>;
};

export type PicklistField = {
  name: string;
  label: string;
  multiSelect: boolean;
  controllerName?: string;
  values: PicklistValue[];
};

export type RecordTypeColumn = {
  id: string;
  developerName: string;
  name: string;
  /** False when the running user cannot read this record type's picklists. */
  accessible: boolean;
};

export type ObjectPicklists = {
  sobject: string;
  recordTypes?: RecordTypeColumn[];
  fields: PicklistField[];
};

/** The synthetic record type every object has, whether or not it uses others. */
export const masterRecordTypeId = '012000000000000AAA';
export const masterRecordTypeName = 'Master';

export const isPicklistField = (field: DescribeFieldWithPicklist): boolean =>
  field.type === 'picklist' || field.type === 'multipicklist';

/**
 * Narrows describe output to the picklist fields, optionally to a named subset.
 * Naming a real field that is not a picklist is a mistake worth reporting
 * separately from naming a field that does not exist at all.
 */
export const selectPicklistFields = (
  fields: readonly DescribeFieldWithPicklist[],
  sobject: string,
  only?: string
): DescribeFieldWithPicklist[] => {
  const picklists = fields.filter(isPicklistField);

  if (only == null) {
    return picklists;
  }

  const requested = only
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const allByLowerName = new Map(fields.map((field) => [field.name.toLowerCase(), field]));
  const resolved: DescribeFieldWithPicklist[] = [];
  const notPicklists: string[] = [];
  const unknown: string[] = [];

  for (const name of requested) {
    const field = allByLowerName.get(name.toLowerCase());

    if (field == null) {
      unknown.push(name);
    } else if (!isPicklistField(field)) {
      notPicklists.push(field.name);
    } else {
      resolved.push(field);
    }
  }

  if (unknown.length > 0) {
    throw new Error(`Unknown field(s) on ${sobject}: ${unknown.join(', ')}`);
  }

  if (notPicklists.length > 0) {
    throw new Error(`Not a picklist field on ${sobject}: ${notPicklists.join(', ')}`);
  }

  return resolved;
};

/** Only active values in v1; inactive values need a Tooling read. */
export const toPicklistField = (field: DescribeFieldWithPicklist): PicklistField => ({
  name: field.name,
  label: field.label,
  multiSelect: field.type === 'multipicklist',
  ...(field.controllerName == null || field.controllerName.length === 0
    ? {}
    : { controllerName: field.controllerName }),
  values: (field.picklistValues ?? [])
    .filter((value) => value.active)
    .map((value) => ({
      value: value.value,
      label: value.label ?? value.value,
      isDefault: value.defaultValue,
    })),
});

export const formatDefaultMarker = (isDefault: boolean): string => (isDefault ? '*' : '');

/** What one UI API picklist-values call tells us about one field. */
export type FieldAvailability = {
  values: Set<string>;
  defaultValue?: string;
};

/** Keyed by field API name. Undefined means the record type could not be read. */
export type RecordTypeAvailability = Map<string, FieldAvailability> | undefined;

/**
 * Folds the per-record-type UI API responses into the value rows, so each value
 * knows which record types offer it and which of them default to it. Record
 * types that could not be read are left out of both maps and rendered as
 * unavailable instead.
 */
export const applyAvailability = (
  fields: readonly PicklistField[],
  recordTypes: readonly RecordTypeColumn[],
  byRecordType: ReadonlyMap<string, RecordTypeAvailability>
): PicklistField[] =>
  fields.map((field) => ({
    ...field,
    values: field.values.map((value) => {
      const availability: Record<string, boolean> = {};
      const defaultFor: Record<string, boolean> = {};

      for (const recordType of recordTypes) {
        const forRecordType = byRecordType.get(recordType.developerName);

        if (forRecordType == null) {
          continue;
        }

        const forField = forRecordType.get(field.name);

        availability[recordType.developerName] = forField?.values.has(value.value) === true;
        defaultFor[recordType.developerName] = forField?.defaultValue === value.value;
      }

      return { ...value, availability, defaultFor };
    }),
  }));

/**
 * One matrix cell: a tick when the value is available, starred when it is that
 * record type's default, and a dash when the record type could not be read.
 */
export const formatAvailabilityCell = (value: PicklistValue, recordType: RecordTypeColumn): string => {
  if (!recordType.accessible) {
    return '-';
  }

  if (value.availability?.[recordType.developerName] !== true) {
    return '';
  }

  return value.defaultFor?.[recordType.developerName] === true ? '✓*' : '✓';
};
