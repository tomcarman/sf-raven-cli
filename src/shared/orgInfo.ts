import dayjs from 'dayjs';

export type OrganizationRecord = {
  Id: string;
  Name: string;
  OrganizationType: string;
  InstanceName: string;
  IsSandbox: boolean;
  CreatedDate: string;
};

export type OrgIdentity = {
  name: string;
  orgId: string;
  edition: string;
  instanceName: string;
  myDomain: string;
  isSandbox: boolean;
  apiVersion: string;
  /** For sandboxes this doubles as the last-refresh date. */
  createdDate: string;
};

export type LimitRow = {
  key: string;
  label: string;
  used: number;
  max: number;
  percent: number;
  unit: 'MB' | 'count';
};

export type LicenseRow = {
  name: string;
  used: number;
  total: number;
};

export type OrgUsers = {
  activeUsers: number;
  licenses: LicenseRow[];
};

export type MaintenanceWindow = {
  name: string;
  start: string;
  end: string;
};

export type ReleaseInfo =
  | { available: true; releaseVersion: string; releaseNumber: string; maintenances: MaintenanceWindow[] }
  | { available: false };

/** The org's My Domain is the host of whatever instance URL we authenticated to. */
export const myDomainFromInstanceUrl = (instanceUrl: string): string => {
  try {
    return new URL(instanceUrl).host;
  } catch {
    return instanceUrl;
  }
};

export type ApiVersionEntry = { version: string };

export const highestApiVersion = (versions: readonly ApiVersionEntry[]): string =>
  versions.reduce((highest, entry) => (Number(entry.version) > Number(highest) ? entry.version : highest), '0.0');

export type LimitsResponse = Record<string, { Max?: number; Remaining?: number } | undefined>;

const limitLabels: ReadonlyArray<{ key: string; label: string; unit: LimitRow['unit'] }> = [
  { key: 'DataStorageMB', label: 'Data storage', unit: 'MB' },
  { key: 'FileStorageMB', label: 'File storage', unit: 'MB' },
  { key: 'DailyApiRequests', label: 'Daily API requests', unit: 'count' },
];

/** `/limits` reports what is left, so used has to be derived from the maximum. */
export const buildLimitRows = (limits: LimitsResponse): LimitRow[] =>
  limitLabels.flatMap(({ key, label, unit }) => {
    const limit = limits[key];

    if (limit?.Max == null) {
      return [];
    }

    const max = limit.Max;
    const used = Math.max(0, max - (limit.Remaining ?? max));

    return [{ key, label, used, max, percent: max === 0 ? 0 : Math.round((used / max) * 1000) / 10, unit }];
  });

const megabytesPerGigabyte = 1024;

export const formatLimitValue = (value: number, unit: LimitRow['unit']): string =>
  unit === 'MB' ? formatStorage(value) : value.toLocaleString();

export const formatStorage = (megabytes: number): string =>
  megabytes >= megabytesPerGigabyte
    ? `${(megabytes / megabytesPerGigabyte).toFixed(1)} GB`
    : `${megabytes.toLocaleString()} MB`;

export type UserLicenseRecord = {
  Name: string;
  UsedLicenses: number | null;
  TotalLicenses: number | null;
};

/** A short breakdown: the licenses actually in use, busiest first. */
export const buildLicenseRows = (records: readonly UserLicenseRecord[], limit: number): LicenseRow[] =>
  records
    .map((record) => ({ name: record.Name, used: record.UsedLicenses ?? 0, total: record.TotalLicenses ?? 0 }))
    .filter((row) => row.used > 0)
    .sort((left, right) => right.used - left.used || left.name.localeCompare(right.name))
    .slice(0, limit);

export const trustStatusUrl = (instanceName: string): string =>
  `https://api.status.salesforce.com/v1/instances/${encodeURIComponent(instanceName)}/status`;

export type TrustStatusResponse = {
  releaseVersion?: string;
  releaseNumber?: string;
  Maintenances?: Array<{ name?: string; plannedStartTime?: string; plannedEndTime?: string }>;
};

/**
 * The Trust API returns past maintenance alongside future, so anything already
 * finished is dropped and the rest sorted soonest first.
 */
export const parseTrustStatus = (
  response: TrustStatusResponse,
  now: Date = new Date(),
  limit = 3
): ReleaseInfo => ({
  available: true,
  releaseVersion: response.releaseVersion ?? '',
  releaseNumber: response.releaseNumber ?? '',
  maintenances: (response.Maintenances ?? [])
    .filter(
      (maintenance): maintenance is { name?: string; plannedStartTime: string; plannedEndTime: string } =>
        typeof maintenance.plannedStartTime === 'string' &&
        typeof maintenance.plannedEndTime === 'string' &&
        new Date(maintenance.plannedEndTime).getTime() >= now.getTime()
    )
    .sort((left, right) => left.plannedStartTime.localeCompare(right.plannedStartTime))
    .slice(0, limit)
    .map((maintenance) => ({
      name: maintenance.name ?? 'Maintenance',
      start: maintenance.plannedStartTime,
      end: maintenance.plannedEndTime,
    })),
});

export const formatMaintenanceWindow = (window: MaintenanceWindow): string => {
  const start = dayjs(window.start);
  const end = dayjs(window.end);
  const endFormat = start.isSame(end, 'day') ? 'HH:mm' : 'YYYY-MM-DD HH:mm';

  return `${start.format('YYYY-MM-DD HH:mm')} to ${end.format(endFormat)}`;
};

export const formatOrgDate = (isoDate: string): string => dayjs(isoDate).format('YYYY-MM-DD');
