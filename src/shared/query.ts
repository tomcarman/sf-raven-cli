const idPattern = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

export const maxEncodedQueryLength = 14_000;

export const isValidSalesforceId = (value: string): boolean => idPattern.test(value);

export const escapeCsvValue = (value: unknown): string => {
  if (value == null) {
    return '';
  }

  const stringValue = typeof value === 'string' ? value : JSON.stringify(value);

  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
};

export const getEncodedQueryLength = (query: string): number => Buffer.byteLength(encodeURIComponent(query), 'utf8');

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
