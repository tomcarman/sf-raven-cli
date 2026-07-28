import chalk from 'chalk';

export type DescribeField = {
  name: string;
  label: string;
  type: string;
  custom?: boolean;
  queryable?: boolean;
  filterable?: boolean;
  compoundFieldName?: string | null;
};

export type UsageMethod = 'sampled' | 'deep';

export type FieldUsage = {
  name: string;
  label: string;
  type: string;
  populated: number;
  total: number;
  percent: number;
  method: UsageMethod;
};

export type ObjectFieldUsage = {
  sobject: string;
  method: UsageMethod;
  sampleSize?: number;
  totalRecords: number;
  fields: FieldUsage[];
};

const barWidth = 10;

/**
 * Compound parents (Address, Geolocation, personal Name) carry no value of
 * their own - their components do - so the parent is dropped and the components
 * counted. base64 fields cannot be queried in bulk at all.
 */
export const eligibleFields = (fields: readonly DescribeField[]): DescribeField[] => {
  const compoundParents = new Set(
    fields.map((field) => field.compoundFieldName).filter((name): name is string => name != null)
  );

  return fields.filter(
    (field) => field.queryable !== false && field.type !== 'base64' && !compoundParents.has(field.name)
  );
};

export type FieldSelection = {
  /** Comma-separated field names to narrow to. */
  only?: string;
  customOnly?: boolean;
};

export const selectFields = (
  fields: readonly DescribeField[],
  sobject: string,
  selection: FieldSelection = {}
): DescribeField[] => {
  const eligible = eligibleFields(fields);
  const customFiltered = selection.customOnly === true ? eligible.filter((field) => field.custom === true) : eligible;

  if (selection.only == null) {
    return customFiltered;
  }

  const requested = selection.only
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const byLowerName = new Map(customFiltered.map((field) => [field.name.toLowerCase(), field]));
  const resolved: DescribeField[] = [];
  const unknown: string[] = [];

  for (const name of requested) {
    const field = byLowerName.get(name.toLowerCase());

    if (field == null) {
      unknown.push(name);
    } else {
      resolved.push(field);
    }
  }

  if (unknown.length > 0) {
    throw new Error(`Unknown or ineligible field(s) on ${sobject}: ${unknown.join(', ')}`);
  }

  return resolved;
};

/**
 * Newest records first. Id breaks CreatedDate ties so every chunked query sees
 * the same sample, which keeps one denominator valid for all fields.
 */
export const buildSampleQuery = (
  sobject: string,
  fields: readonly string[],
  sampleSize: number,
  hasCreatedDate: boolean
): string => {
  const order = hasCreatedDate ? 'CreatedDate DESC, Id DESC' : 'Id DESC';

  return `SELECT ${fields.join(', ')} FROM ${sobject} ORDER BY ${order} LIMIT ${sampleSize}`;
};

/** Empty strings count as unpopulated - a blank text field is a dead field. */
export const isPopulated = (value: unknown): boolean => value != null && value !== '';

export const countPopulated = (
  records: ReadonlyArray<Record<string, unknown>>,
  fieldNames: readonly string[]
): Map<string, number> => {
  const counts = new Map(fieldNames.map((name) => [name, 0]));

  for (const record of records) {
    for (const name of fieldNames) {
      if (isPopulated(record[name])) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }

  return counts;
};

export const toPercent = (populated: number, total: number): number =>
  total === 0 ? 0 : Math.round((populated / total) * 1000) / 10;

export const buildFieldUsage = (
  fields: readonly DescribeField[],
  counts: ReadonlyMap<string, number>,
  total: number,
  method: UsageMethod
): FieldUsage[] =>
  fields.map((field) => {
    const populated = counts.get(field.name) ?? 0;

    return {
      name: field.name,
      label: field.label,
      type: field.type,
      populated,
      total,
      percent: toPercent(populated, total),
      method,
    };
  });

/** Dead fields first; alphabetical within a tie. */
export const sortFieldUsage = (fields: readonly FieldUsage[]): FieldUsage[] =>
  [...fields].sort((left, right) => left.percent - right.percent || left.name.localeCompare(right.name));

export const usageBar = (percent: number): string => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * barWidth);

  return `${chalk.cyan('█'.repeat(filled))}${chalk.dim('░'.repeat(barWidth - filled))}`;
};

export const formatPercent = (percent: number): string => `${percent}%`;

/**
 * In deep mode every field carries a real org-wide count except the ones that
 * cannot be filtered on, so those are labelled to keep the table honest.
 */
export const formatUsageMethod = (field: FieldUsage, objectMethod: UsageMethod): string =>
  objectMethod === 'deep' && field.method === 'sampled' ? chalk.dim(' (sampled)') : '';

/**
 * Booleans are excluded despite being filterable: SOQL matches no rows at all
 * for `boolean != null`, which would report every checkbox as 0% populated.
 * They keep their sampled figure, which correctly reads 100%.
 */
export const isDeepCountable = (field: DescribeField): boolean =>
  field.filterable === true && field.type !== 'boolean';

export const buildDeepCountQuery = (sobject: string, fieldName: string): string =>
  `SELECT COUNT() FROM ${sobject} WHERE ${fieldName} != null`;

/**
 * Runs `task` over every item with at most `limit` in flight, so a wide object
 * does not open one request per field at once.
 */
export const mapWithConcurrency = async <Item, Output>(
  items: readonly Item[],
  limit: number,
  task: (item: Item) => Promise<Output>
): Promise<Output[]> => {
  const results = new Array<Output>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      // eslint-disable-next-line no-await-in-loop
      results[index] = await task(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
};
