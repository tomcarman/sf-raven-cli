export type PublishResult = {
  index: number;
  success: boolean;
  id?: string;
  errors?: string[];
};

const channelPrefix = '/event/';

/**
 * Accepts what `event subscribe` takes as well as a bare API name, so muscle
 * memory from the subscribe side works here too.
 */
export const normalizeEventName = (event: string): string => {
  const trimmed = event.trim();
  const withoutChannel = trimmed.toLowerCase().startsWith(channelPrefix)
    ? trimmed.slice(channelPrefix.length)
    : trimmed;

  return withoutChannel.replace(/^\/+/, '');
};

/** A payload that starts with a JSON opener is JSON; anything else is a path. */
export const isInlinePayload = (payload: string): boolean => {
  const trimmed = payload.trimStart();

  return trimmed.startsWith('{') || trimmed.startsWith('[');
};

export const parsePayload = (text: string, source: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not read ${source} as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * A top-level object publishes one event; a top-level array publishes each of
 * its elements.
 */
export const toEventRecords = (parsed: unknown, source: string): Array<Record<string, unknown>> => {
  const candidates = Array.isArray(parsed) ? parsed : [parsed];

  if (candidates.length === 0) {
    throw new Error(`${source} contains no events to publish.`);
  }

  return candidates.map((candidate, index) => {
    if (!isPlainRecord(candidate)) {
      throw new Error(
        Array.isArray(parsed)
          ? `Event ${index + 1} in ${source} is not a JSON object.`
          : `${source} is not a JSON object.`
      );
    }

    return candidate;
  });
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value != null && !Array.isArray(value);

export type CreateOutcome = {
  id?: string;
  success?: boolean;
  errors?: unknown;
};

/**
 * A successful platform event insert comes back with a placeholder `id` and an
 * OPERATION_ENQUEUED entry in `errors` whose message is the real event UUID -
 * so that entry is the identifier, not a failure.
 */
const enqueuedStatus = 'OPERATION_ENQUEUED';

export const toPublishResult = (index: number, outcome: CreateOutcome): PublishResult => {
  const entries = toErrorEntries(outcome.errors);
  const enqueued = entries.find((entry) => entry.statusCode === enqueuedStatus);
  const failures = entries.filter((entry) => entry.statusCode !== enqueuedStatus).map(describeError);

  if (outcome.success === true) {
    return { index, success: true, id: enqueued?.message ?? outcome.id ?? '' };
  }

  return { index, success: false, errors: failures.length > 0 ? failures : ['Publish failed.'] };
};

export const toFailedResult = (index: number, error: unknown): PublishResult => ({
  index,
  success: false,
  errors: [error instanceof Error ? error.message : String(error)],
});

type ErrorEntry = {
  statusCode?: string;
  message?: string;
  raw: unknown;
};

const toErrorEntries = (errors: unknown): ErrorEntry[] => {
  if (errors == null) {
    return [];
  }

  const list: unknown[] = Array.isArray(errors) ? (errors as unknown[]) : [errors];

  return list.map((error) =>
    isPlainRecord(error)
      ? {
          statusCode: typeof error.statusCode === 'string' ? error.statusCode : undefined,
          message: typeof error.message === 'string' ? error.message : undefined,
          raw: error,
        }
      : { message: typeof error === 'string' ? error : undefined, raw: error }
  );
};

const describeError = (entry: ErrorEntry): string => {
  const parts = [entry.statusCode, entry.message].filter((part): part is string => part != null && part.length > 0);

  return parts.length > 0 ? parts.join(': ') : JSON.stringify(entry.raw);
};
