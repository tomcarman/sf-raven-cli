export type ApexLogRecordFields = {
  Operation: string;
  DurationMilliseconds: number;
  Status: string;
  StartTime: string;
};

export type LogEvent = {
  type: 'log';
  id: string;
  operation: string;
  createdDate: string;
  durationMs: number;
  status: string;
  body: string;
};

export type StatusEventName = 'connected' | 'traceActive' | 'traceCreated' | 'timeout';

export type StatusEvent = {
  type: 'status';
  event: StatusEventName;
  traceExpiry?: string;
};

export type ErrorEvent = {
  type: 'error';
  message: string;
};

export type StreamEvent = LogEvent | StatusEvent | ErrorEvent;

export const buildLogEvent = (
  id: string,
  createdDate: string | undefined,
  record: ApexLogRecordFields | undefined,
  body: string
): LogEvent => ({
  type: 'log',
  id,
  operation: record?.Operation ?? 'Log',
  createdDate: createdDate ?? record?.StartTime ?? '',
  durationMs: record?.DurationMilliseconds ?? 0,
  status: record?.Status ?? 'Unknown',
  body,
});

export const buildStatusEvent = (event: StatusEventName, traceExpiry?: string): StatusEvent =>
  traceExpiry == null ? { type: 'status', event } : { type: 'status', event, traceExpiry };

export const buildErrorEvent = (message: string): ErrorEvent => ({ type: 'error', message });

export const serializeEvent = (event: StreamEvent): string => JSON.stringify(event);
