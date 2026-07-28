import { Messages, StreamingClient } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import type { JsonMap } from '@salesforce/ts-types';
import dayjs from 'dayjs';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import {
  buildErrorEvent,
  buildLogEvent,
  buildStatusEvent,
  serializeEvent,
  type ApexLogRecordFields,
  type StreamEvent,
} from '../../../shared/apexLogEvents.js';
import { formatLogHeader, parseLogLines } from '../../../shared/apexLogRender.js';

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
    CreatedDate?: string;
  };
};

type TraceFlagStatus = { state: 'active' | 'created'; expiry: string } | { state: 'declined' };

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
    ndjson: Flags.boolean({
      summary: messages.getMessage('flags.ndjson.summary'),
      default: false,
    }),
    timeout: Flags.integer({
      summary: messages.getMessage('flags.timeout.summary'),
      char: 't',
      min: 3,
      max: 30,
      default: 3,
    }),
  };

  public async run(): Promise<RavenApexLogResult> {
    const { flags } = await this.parse(RavenApexLog);
    const ndjson = flags.ndjson;
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() || ndjson });
    const emit = ndjson ? writeEventLine : undefined;

    let logsReceived = 0;

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
      const confirmCreate = ndjson
        ? (): Promise<boolean> => Promise.resolve(true)
        : (): Promise<boolean> =>
            this.confirm({ message: messages.getMessage('prompt.createTrace'), defaultAnswer: true });

      const trace = await ensureTraceFlag(connection, userId, confirmCreate);

      if (trace.state === 'active') {
        ux.log(messages.getMessage('info.traceActive', [dayjs(trace.expiry).format('HH:mm:ss')]));
        emit?.(buildStatusEvent('traceActive', trace.expiry));
      } else if (trace.state === 'created') {
        ux.log(messages.getMessage('info.traceCreated', [dayjs(trace.expiry).format('HH:mm:ss')]));
        emit?.(buildStatusEvent('traceCreated', trace.expiry));
      }
    }

    const seenLogIds = new Set<string>();

    const streamProcessor = (message: JsonMap): { completed: boolean } => {
      const notification = message as unknown as LogNotification;
      const id = notification.sobject?.Id;

      if (id != null && !seenLogIds.has(id)) {
        seenLogIds.add(id);
        setTimeout(() => seenLogIds.delete(id), 30_000);

        void handleLogNotification(notification, connection, flags.filter, flags.raw, ux, emit)
          .then(() => {
            logsReceived++;
          })
          .catch((error: unknown) => {
            if (emit == null) {
              throw error;
            }

            emit(buildErrorEvent(error instanceof Error ? error.message : String(error)));
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

    emit?.(buildStatusEvent('connected'));
    ux.log(messages.getMessage('info.streaming', [username]));

    try {
      await client.subscribe(async () => Promise.resolve());
    } catch (error) {
      if (isSubscribeTimeoutError(error)) {
        ux.log(messages.getMessage('info.timeout'));
        emit?.(buildStatusEvent('timeout'));
      } else {
        throw error;
      }
    }

    return { logsReceived };
  }

  protected async catch(error: Error): Promise<never> {
    if (this.argv.includes('--ndjson')) {
      writeEventLine(buildErrorEvent(error.message));
      return this.exit(1);
    }

    return super.catch(error);
  }
}

const writeEventLine = (event: StreamEvent): void => {
  process.stdout.write(`${serializeEvent(event)}\n`);
};

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
  confirmCreate: () => Promise<boolean>
): Promise<TraceFlagStatus> => {
  const now = new Date().toISOString();

  const existing = await connection.tooling.query<TraceFlagRecord>(
    `SELECT Id, ExpirationDate FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'USER_DEBUG' AND ExpirationDate > ${now} LIMIT 1`
  );

  if (existing.records.length > 0) {
    return { state: 'active', expiry: existing.records[0].ExpirationDate };
  }

  if (!(await confirmCreate())) {
    return { state: 'declined' };
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

  return { state: 'created', expiry };
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
  ux: Ux,
  emit?: (event: StreamEvent) => void
): Promise<void> => {
  const { Id, CreatedDate } = notification.sobject;

  const [body, record] = await Promise.all([fetchLogBody(connection, Id), fetchLogRecord(connection, Id)]);

  if (emit != null) {
    emit(buildLogEvent(Id, CreatedDate, record, body));
    return;
  }

  const header = formatLogHeader(
    record?.Operation,
    CreatedDate ?? record?.StartTime,
    record?.DurationMilliseconds,
    record?.Status
  );

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

const fetchLogRecord = async (connection: ToolingConnection, logId: string): Promise<ApexLogRecordFields | undefined> => {
  const result = await connection.tooling.query<ApexLogRecordFields>(
    `SELECT Operation, DurationMilliseconds, Status, StartTime FROM ApexLog WHERE Id = '${logId}' LIMIT 1`
  );

  return result.records[0];
};

const isSubscribeTimeoutError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'GenericTimeoutError';
