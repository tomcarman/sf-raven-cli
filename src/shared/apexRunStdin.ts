import type { ApexRunResult } from './apexRun.js';

/** One line of `apex run --stdin` input. */
export type StdinRunRequest = {
  id: string;
  code: string;
};

export type ApexStdinReadyEvent = { type: 'ready' };

export type ApexStdinRunStartEvent = { type: 'run-start'; id: string };

export type ApexStdinRunEvent = ApexRunResult & { type: 'run'; id: string };

/** A run that failed (with its id), or a line that was not a run request (no id). */
export type ApexStdinErrorEvent = { type: 'error'; id?: string; message: string };

export type ApexStdinEvent = ApexStdinReadyEvent | ApexStdinRunStartEvent | ApexStdinRunEvent | ApexStdinErrorEvent;

export type ApexRunModeFlags = {
  watch: boolean;
  ndjson: boolean;
  stdin: boolean;
  json: boolean;
  /** --file was given, not left at its default. */
  fileSet: boolean;
};

export type ApexRunFlagError =
  | 'error.watchWithJson'
  | 'error.ndjsonRequiresWatch'
  | 'error.stdinRequiresNdjson'
  | 'error.stdinExclusive';

/** The message key for a flag combination `apex run` refuses, or undefined when it is fine. */
export const apexRunFlagError = (flags: ApexRunModeFlags): ApexRunFlagError | undefined => {
  if (flags.stdin) {
    if (flags.fileSet || flags.watch || flags.json) return 'error.stdinExclusive';
    if (!flags.ndjson) return 'error.stdinRequiresNdjson';
    return undefined;
  }

  if (flags.watch && flags.json) return 'error.watchWithJson';
  if (flags.ndjson && !flags.watch) return 'error.ndjsonRequiresWatch';
  return undefined;
};

const INVALID_LINE = 'Expected one JSON object per line: {"id": "<string>", "code": "<apex>"}';

export const parseStdinRunRequest = (line: string): StdinRunRequest | { error: string } => {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    return { error: `${INVALID_LINE}. The line is not valid JSON.` };
  }

  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return { error: INVALID_LINE };
  }

  const { id, code } = value as Record<string, unknown>;

  if (typeof id !== 'string' || id === '' || typeof code !== 'string') {
    return { error: INVALID_LINE };
  }

  return { id, code };
};

export type ServeApexStdinOptions = {
  /** Input lines, such as stdin read through readline. */
  lines: AsyncIterable<string>;
  execute: (code: string) => Promise<ApexRunResult>;
  write: (event: ApexStdinEvent) => void;
};

/**
 * Serves `apex run --stdin`: sends `ready`, then runs each request line one at a time, in the
 * order received. Nothing runs that did not arrive as input. Resolves once the input ends and
 * the run in progress (if any) has finished.
 */
export const serveApexStdin = async ({ lines, execute, write }: ServeApexStdinOptions): Promise<void> => {
  write({ type: 'ready' });

  for await (const line of lines) {
    if (line.trim() === '') {
      continue;
    }

    const request = parseStdinRunRequest(line);

    if ('error' in request) {
      write({ type: 'error', message: request.error });
      continue;
    }

    write({ type: 'run-start', id: request.id });

    try {
      // Runs are one at a time by design: the next line is not read until this one finishes.
      // eslint-disable-next-line no-await-in-loop
      const result = await execute(request.code);
      write({ type: 'run', id: request.id, ...result });
    } catch (error) {
      write({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
};
