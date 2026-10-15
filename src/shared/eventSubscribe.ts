export type EventLine = {
  type: 'event';
  channel: string;
  replayId: number | null;
  /** ISO time the CLI received the message. */
  receivedAt: string;
  /** The event payload as delivered; for change events it includes ChangeEventHeader. */
  payload: unknown;
};

export type StatusEventName = 'connected' | 'timeout';

export type StatusLine = {
  type: 'status';
  event: StatusEventName;
};

export type ErrorLine = {
  type: 'error';
  message: string;
};

export type SubscribeLine = EventLine | StatusLine | ErrorLine;

/** The shape CometD delivers for platform and change events. */
type StreamingMessage = {
  payload?: unknown;
  event?: { replayId?: unknown };
};

/**
 * Build an event line from a streaming message. A message without a `payload`
 * (e.g. a /topic/ PushTopic notification) is passed through whole so nothing is lost.
 */
export const buildEventLine = (channel: string, message: unknown, receivedAt: Date): EventLine => {
  const msg = (message ?? {}) as StreamingMessage;
  const replayId = msg.event?.replayId;

  return {
    type: 'event',
    channel,
    replayId: typeof replayId === 'number' ? replayId : null,
    receivedAt: receivedAt.toISOString(),
    payload: msg.payload !== undefined ? msg.payload : message ?? null,
  };
};

export const buildStatusLine = (event: StatusEventName): StatusLine => ({ type: 'status', event });

export const buildErrorLine = (message: string): ErrorLine => ({ type: 'error', message });

export const serializeLine = (line: SubscribeLine): string => JSON.stringify(line);

/**
 * Map what the user typed for --event onto a streaming channel:
 * - `My_Event__e` -> `/event/My_Event__e`
 * - `AccountChangeEvent`, `My_Object__ChangeEvent` -> `/data/...`
 * - anything starting with `/` (`/event/...`, `/data/...`, `/topic/...`) is used as is.
 */
export const resolveEventChannel = (event: string): string => {
  const name = event.trim();

  if (name === '') {
    throw new Error('Event name is empty.');
  }

  if (name.startsWith('/')) {
    return name;
  }

  return name.endsWith('ChangeEvent') ? `/data/${name}` : `/event/${name}`;
};

export const TERMINAL_DEFAULT_TIMEOUT_MINUTES = 3;
export const TERMINAL_MAX_TIMEOUT_MINUTES = 30;

/**
 * Stand-in for "no timeout". StreamingClient always arms a subscribe timer, and
 * Node's setTimeout overflows above 2^31-1 ms (about 24.8 days) to an immediate
 * fire, so this stays just under that.
 */
export const NO_TIMEOUT_MINUTES = 24 * 24 * 60;

export type EventSubscribeModeFlags = {
  ndjson: boolean;
  json: boolean;
  timeout: number | undefined;
};

export type EventSubscribeFlagError = 'error.ndjsonWithJson' | 'error.timeoutTooLong';

/** The message key for a flag combination `event subscribe` refuses, or undefined when it is fine. */
export const eventSubscribeFlagError = (flags: EventSubscribeModeFlags): EventSubscribeFlagError | undefined => {
  if (flags.ndjson && flags.json) return 'error.ndjsonWithJson';
  if (!flags.ndjson && flags.timeout != null && flags.timeout > TERMINAL_MAX_TIMEOUT_MINUTES) {
    return 'error.timeoutTooLong';
  }
  return undefined;
};

/**
 * Subscribe timeout in minutes. Terminal mode defaults to 3 (max 30, enforced by
 * eventSubscribeFlagError); ndjson mode has no timeout unless --timeout is given.
 */
export const subscribeTimeoutMinutes = (timeout: number | undefined, ndjson: boolean): number => {
  if (ndjson) {
    return Math.min(timeout ?? NO_TIMEOUT_MINUTES, NO_TIMEOUT_MINUTES);
  }

  return timeout ?? TERMINAL_DEFAULT_TIMEOUT_MINUTES;
};
