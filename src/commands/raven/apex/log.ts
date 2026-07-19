import { Messages, StreamingClient } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import type { JsonMap } from '@salesforce/ts-types';
import chalk from 'chalk';
import dayjs from 'dayjs';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.apex.log');

type ToolingQueryResult<T> = { records: T[] };
type TraceFlagRecord = { Id: string; ExpirationDate: string };
type DebugLevelRecord = { Id: string };
type UserRecord = { Id: string };

type ToolingConnection = {
  tooling: {
    query: <T>(soql: string) => Promise<ToolingQueryResult<T>>;
    create: (type: string, fields: Record<string, string>) => Promise<{ id: string; success: boolean }>;
    delete: (type: string, id: string) => Promise<{ id: string; success: boolean }>;
  };
  query: <T>(soql: string) => Promise<{ records: T[] }>;
  instanceUrl: string;
  accessToken: string | undefined;
  getApiVersion: () => string;
};

type LogNotification = {
  sobject: {
    Id: string;
    CreatedDate: string;
  };
};

type ApexLogRecord = {
  Operation: string;
  DurationMilliseconds: number;
  Status: string;
};

export type RavenApexLogResult = {
  logsReceived: number;
};

export default class RavenApexLog extends SfCommand<RavenApexLogResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.optionalOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
    }),
    user: Flags.string({
      summary: messages.getMessage('flags.user.summary'),
      char: 'u',
    }),
    filter: Flags.string({
      summary: messages.getMessage('flags.filter.summary'),
      char: 'f',
    }),
    raw: Flags.boolean({
      summary: messages.getMessage('flags.raw.summary'),
      default: false,
    }),
    'no-trace': Flags.boolean({
      summary: messages.getMessage('flags.no-trace.summary'),
      default: false,
    }),
    timeout: Flags.integer({
      summary: messages.getMessage('flags.timeout.summary'),
      char: 't',
      min: 1,
      max: 30,
      default: 3,
    }),
  };

  public async run(): Promise<RavenApexLogResult> {
    const { flags } = await this.parse(RavenApexLog);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    const org = flags['target-org'];

    if (org == null) {
      throw messages.createError('error.noTargetOrg');
    }

    const connection = org.getConnection() as unknown as ToolingConnection;
    const username = flags.user ?? org.getUsername();

    if (username == null) {
      throw messages.createError('error.noUsername');
    }

    const userId = await resolveUserId(connection, username);

    if (!flags['no-trace']) {
      await ensureTraceFlag(connection, userId, ux, this);
    }

    let logsReceived = 0;
    const seenLogIds = new Set<string>();

    const streamProcessor = (message: JsonMap): { completed: boolean } => {
      const notification = message as unknown as LogNotification;
      const id = notification.sobject?.Id;

      if (id != null && !seenLogIds.has(id)) {
        seenLogIds.add(id);
        setTimeout(() => seenLogIds.delete(id), 30_000);

        void handleLogNotification(notification, connection, flags.filter, flags.raw, ux).then(() => {
          logsReceived++;
        });
      }

      return { completed: false };
    };

    const options = new StreamingClient.DefaultOptions(org, '/systemTopic/Logging', streamProcessor);
    options.setSubscribeTimeout(Duration.minutes(flags.timeout));

    const client = await StreamingClient.create(options);

    process.removeAllListeners('SIGINT');
    process.once('SIGINT', () => {
      ux.log(messages.getMessage('info.exiting'));
      process.exit(130);
    });

    ux.spinner.start(messages.getMessage('info.connecting'));
    await client.handshake();
    client.replay(-1);
    ux.spinner.stop();

    ux.log(messages.getMessage('info.streaming', [username]));

    try {
      await client.subscribe(async () => Promise.resolve());
    } catch (error) {
      if (isSubscribeTimeoutError(error)) {
        ux.log(messages.getMessage('info.timeout'));
      } else {
        throw error;
      }
    }

    return { logsReceived };
  }
}

const resolveUserId = async (connection: ToolingConnection, username: string): Promise<string> => {
  const result = await connection.query<UserRecord>(
    `SELECT Id FROM User WHERE Username = '${username}' LIMIT 1`
  );

  if (result.records.length === 0) {
    throw new Error(`User not found: ${username}`);
  }

  return result.records[0].Id;
};

const ensureTraceFlag = async (
  connection: ToolingConnection,
  userId: string,
  ux: Ux,
  command: SfCommand<RavenApexLogResult>
): Promise<void> => {
  const now = new Date().toISOString();

  const existing = await connection.tooling.query<TraceFlagRecord>(
    `SELECT Id, ExpirationDate FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'USER_DEBUG' AND ExpirationDate > ${now} LIMIT 1`
  );

  if (existing.records.length > 0) {
    const expiry = dayjs(existing.records[0].ExpirationDate).format('HH:mm:ss');
    ux.log(messages.getMessage('info.traceActive', [expiry]));
    return;
  }

  const confirmed = await command.confirm({
    message: messages.getMessage('prompt.createTrace'),
    defaultAnswer: true,
  });

  if (!confirmed) {
    return;
  }

  const debugLevelId = await ensureDebugLevel(connection);
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await connection.tooling.create('TraceFlag', {
    DebugLevelId: debugLevelId,
    LogType: 'USER_DEBUG',
    TracedEntityId: userId,
    StartDate: now,
    ExpirationDate: expiry,
  });

  ux.log(messages.getMessage('info.traceCreated', [dayjs(expiry).format('HH:mm:ss')]));
};

const ensureDebugLevel = async (connection: ToolingConnection): Promise<string> => {
  const existing = await connection.tooling.query<DebugLevelRecord>(
    'SELECT Id FROM DebugLevel WHERE DeveloperName = \'sf_raven\' LIMIT 1'
  );

  if (existing.records.length > 0) {
    return existing.records[0].Id;
  }

  const result = await connection.tooling.create('DebugLevel', {
    DeveloperName: 'sf_raven',
    MasterLabel: 'sf-raven',
    ApexCode: 'DEBUG',
    ApexProfiling: 'INFO',
    Callout: 'INFO',
    Database: 'INFO',
    System: 'DEBUG',
    Validation: 'INFO',
    Visualforce: 'INFO',
    Workflow: 'INFO',
    NBA: 'INFO',
    Wave: 'INFO',
  });

  return result.id;
};

const handleLogNotification = async (
  notification: LogNotification,
  connection: ToolingConnection,
  filter: string | undefined,
  raw: boolean,
  ux: Ux
): Promise<void> => {
  const { Id, CreatedDate } = notification.sobject;

  const [body, record] = await Promise.all([fetchLogBody(connection, Id), fetchLogRecord(connection, Id)]);

  const header = formatLogHeader(record?.Operation, CreatedDate, record?.DurationMilliseconds, record?.Status);

  if (raw) {
    ux.log(header);
    ux.log(body);
    return;
  }

  const lines = parseLogLines(body, filter);

  if (lines.length === 0) {
    return;
  }

  ux.log(header);

  for (const line of lines) {
    ux.log(line);
  }

  ux.log('');
};

const fetchLogBody = async (connection: ToolingConnection, logId: string): Promise<string> => {
  const url = `${connection.instanceUrl}/services/data/v${connection.getApiVersion()}/tooling/sobjects/ApexLog/${logId}/Body`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${connection.accessToken ?? ''}` },
  });

  return response.text();
};

const fetchLogRecord = async (connection: ToolingConnection, logId: string): Promise<ApexLogRecord | undefined> => {
  const result = await connection.tooling.query<ApexLogRecord>(
    `SELECT Operation, DurationMilliseconds, Status FROM ApexLog WHERE Id = '${logId}' LIMIT 1`
  );

  return result.records[0];
};

const parseLogLines = (body: string, filter?: string): string[] => {
  const result: string[] = [];

  for (const line of body.split('\n')) {
    if (line.includes('|USER_DEBUG|')) {
      const parts = line.split('|');

      if (parts.length >= 5) {
        const lineNum = parts[2];
        const level = parts[3];
        const message = parts.slice(4).join('|');

        if (filter == null || message.includes(filter)) {
          result.push(`  ${chalk.dim(lineNum.padEnd(5))} ${formatLevel(level)}  ${message}`);
        }
      }
    } else if (line.includes('|EXCEPTION_THROWN|') || line.includes('|FATAL_ERROR|')) {
      const parts = line.split('|');
      result.push(chalk.red(`  ⚠  ${parts.slice(2).join('|')}`));
    }
  }

  return result;
};

const formatLevel = (level: string): string => {
  const padded = level.padEnd(7);
  switch (level) {
    case 'ERROR':  return chalk.red.bold(padded);
    case 'WARN':   return chalk.yellow(padded);
    case 'INFO':   return chalk.cyan(padded);
    case 'FINE':
    case 'FINER':
    case 'FINEST': return chalk.dim(padded);
    default:       return chalk.dim(padded); // DEBUG
  }
};

const formatLogHeader = (operation: string | undefined, createdDate: string, duration: number | undefined, status: string | undefined): string => {
  const time = dayjs(createdDate).format('HH:mm:ss');
  const op = operation ?? 'Log';
  const durationStr = duration != null ? `  ${duration}ms` : '';
  const failed = status != null && status !== 'Success' ? ' ' + chalk.red.bold(`[${status}]`) : '';
  return `\n${chalk.dim('──')} ${chalk.bold.cyan(op)}  ${chalk.dim(`${time}${durationStr}`)}${failed} ${chalk.dim('──')}`;
};

const isSubscribeTimeoutError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'GenericTimeoutError';
