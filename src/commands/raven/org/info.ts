import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import chalk from 'chalk';
import {
  buildLicenseRows,
  buildLimitRows,
  formatLimitValue,
  formatMaintenanceWindow,
  formatOrgDate,
  highestApiVersion,
  myDomainFromInstanceUrl,
  parseTrustStatus,
  trustStatusUrl,
  type ApiVersionEntry,
  type LimitRow,
  type LimitsResponse,
  type OrganizationRecord,
  type OrgIdentity,
  type OrgUsers,
  type ReleaseInfo,
  type TrustStatusResponse,
  type UserLicenseRecord,
} from '../../../shared/orgInfo.js';
import { usageBar } from '../../../shared/table.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.org.info');

/** The Trust API is the one unauthenticated external call; it must not hold the command up. */
const trustTimeoutMs = 5000;
const topLicenses = 5;

export type OrgInfoResult = {
  identity: OrgIdentity;
  limits: LimitRow[];
  users: OrgUsers;
  release: ReleaseInfo;
};

export default class OrgInfo extends SfCommand<OrgInfoResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
    }),
  };

  public async run(): Promise<OrgInfoResult> {
    const { flags } = await this.parse(OrgInfo);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const connection = flags['target-org'].getConnection();

    this.spinner.start(messages.getMessage('info.loading'));

    let result: OrgInfoResult;

    try {
      const organization = await fetchOrganization(connection);

      const [apiVersion, limits, users, release] = await Promise.all([
        fetchHighestApiVersion(connection),
        fetchLimits(connection),
        fetchUsers(connection),
        fetchRelease(organization.InstanceName),
      ]);

      result = {
        identity: buildIdentity(organization, connection.instanceUrl, apiVersion),
        limits,
        users,
        release,
      };
    } finally {
      this.spinner.stop();
    }

    printCard(ux, result);

    return result;
  }
}

const buildIdentity = (
  organization: OrganizationRecord,
  instanceUrl: string,
  apiVersion: string
): OrgIdentity => ({
  name: organization.Name,
  orgId: organization.Id,
  edition: organization.OrganizationType,
  instanceName: organization.InstanceName,
  myDomain: myDomainFromInstanceUrl(instanceUrl),
  isSandbox: organization.IsSandbox,
  apiVersion,
  createdDate: organization.CreatedDate,
});

const fetchOrganization = async (connection: Connection): Promise<OrganizationRecord> => {
  const result = await connection.query<OrganizationRecord>(
    'SELECT Id, Name, OrganizationType, InstanceName, IsSandbox, CreatedDate FROM Organization LIMIT 1'
  );

  if (result.records.length === 0) {
    throw messages.createError('error.noOrganization');
  }

  return result.records[0];
};

const fetchHighestApiVersion = async (connection: Connection): Promise<string> => {
  const versions = await connection.request<ApiVersionEntry[]>({ method: 'GET', url: '/services/data' });

  return highestApiVersion(versions);
};

const fetchLimits = async (connection: Connection): Promise<LimitRow[]> => {
  const limits = await connection.request<LimitsResponse>({
    method: 'GET',
    url: `/services/data/v${connection.getApiVersion()}/limits`,
  });

  return buildLimitRows(limits);
};

const fetchUsers = async (connection: Connection): Promise<OrgUsers> => {
  const [active, licenses] = await Promise.all([
    connection.query('SELECT COUNT() FROM User WHERE IsActive = true'),
    connection.query<UserLicenseRecord>(
      "SELECT Name, UsedLicenses, TotalLicenses FROM UserLicense WHERE Status = 'Active' ORDER BY UsedLicenses DESC"
    ),
  ]);

  return { activeUsers: active.totalSize, licenses: buildLicenseRows(licenses.records, topLicenses) };
};

const fetchRelease = async (instanceName: string): Promise<ReleaseInfo> => {
  try {
    const response = await fetch(trustStatusUrl(instanceName), { signal: AbortSignal.timeout(trustTimeoutMs) });

    if (!response.ok) {
      return { available: false };
    }

    return parseTrustStatus((await response.json()) as TrustStatusResponse);
  } catch {
    return { available: false };
  }
};

const printCard = (ux: Ux, result: OrgInfoResult): void => {
  const { identity } = result;

  section(ux, messages.getMessage('label.identity'));
  row(ux, messages.getMessage('label.name'), identity.name);
  row(ux, messages.getMessage('label.orgId'), identity.orgId);
  row(ux, messages.getMessage('label.edition'), identity.edition);
  row(ux, messages.getMessage('label.instance'), identity.instanceName);
  row(ux, messages.getMessage('label.myDomain'), identity.myDomain);
  row(ux, messages.getMessage('label.sandbox'), identity.isSandbox ? 'Yes' : 'No');
  row(
    ux,
    // Sandboxes are re-created on refresh, so their created date is the refresh date.
    messages.getMessage(identity.isSandbox ? 'label.refreshed' : 'label.created'),
    formatOrgDate(identity.createdDate)
  );
  row(ux, messages.getMessage('label.apiVersion'), identity.apiVersion);

  section(ux, messages.getMessage('label.limits'));

  // Pad the used/max text so the bars line up down the section.
  const usageTexts = result.limits.map(
    (limit) => `${formatLimitValue(limit.used, limit.unit)} / ${formatLimitValue(limit.max, limit.unit)}`
  );
  const usageWidth = Math.max(0, ...usageTexts.map((text) => text.length));

  result.limits.forEach((limit, index) => {
    row(
      ux,
      limit.label,
      `${usageTexts[index].padEnd(usageWidth)}  ${usageBar(limit.percent)} ${chalk.dim(`${limit.percent}%`)}`
    );
  });

  section(ux, messages.getMessage('label.users'));
  row(ux, messages.getMessage('label.activeUsers'), result.users.activeUsers.toLocaleString());

  for (const license of result.users.licenses) {
    row(ux, license.name, `${license.used.toLocaleString()} / ${license.total.toLocaleString()}`);
  }

  section(ux, messages.getMessage('label.release'));

  if (!result.release.available) {
    ux.log(chalk.dim(messages.getMessage('info.trustUnavailable')));
    return;
  }

  row(ux, messages.getMessage('label.releaseVersion'), result.release.releaseVersion);
  row(ux, messages.getMessage('label.releaseNumber'), result.release.releaseNumber);

  if (result.release.maintenances.length === 0) {
    row(ux, messages.getMessage('label.maintenance'), messages.getMessage('info.noMaintenance'));
    return;
  }

  for (const [index, maintenance] of result.release.maintenances.entries()) {
    row(ux, index === 0 ? messages.getMessage('label.maintenance') : '', `${formatMaintenanceWindow(maintenance)}  ${chalk.dim(maintenance.name)}`);
  }
};

const labelWidth = 20;

const section = (ux: Ux, title: string): void => {
  ux.log(`\n${chalk.bold.cyan(title)}\n`);
};

const row = (ux: Ux, label: string, value: string): void => {
  // Long labels still get a gap rather than running into their value.
  const padded = label.length >= labelWidth ? `${label}  ` : label.padEnd(labelWidth);

  ux.log(`  ${chalk.dim(padded)}${value}`);
};
