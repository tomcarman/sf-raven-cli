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
};

export type PicklistField = {
  name: string;
  label: string;
  multiSelect: boolean;
  controllerName?: string;
  values: PicklistValue[];
};

export type ObjectPicklists = {
  sobject: string;
  fields: PicklistField[];
};

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
