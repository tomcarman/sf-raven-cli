import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import chalk from 'chalk';
import {
  isInlinePayload,
  normalizeEventName,
  parsePayload,
  toEventRecords,
  toFailedResult,
  toPublishResult,
  type CreateOutcome,
  type PublishResult,
} from '../../../shared/eventPublish.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.event.publish');

export type EventPublishResult = PublishResult[];

export default class EventPublish extends SfCommand<EventPublishResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
    }),
    event: Flags.string({
      summary: messages.getMessage('flags.event.summary'),
      char: 'e',
      required: true,
    }),
    payload: Flags.string({
      summary: messages.getMessage('flags.payload.summary'),
      char: 'p',
      required: true,
    }),
  };

  public async run(): Promise<EventPublishResult> {
    const { flags } = await this.parse(EventPublish);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    const eventName = normalizeEventName(flags.event);
    const records = await readEvents(flags.payload);
    const connection = flags['target-org'].getConnection();

    const results: PublishResult[] = [];

    for (const [index, record] of records.entries()) {
      // Sequential so each result line lands in payload order.
      // eslint-disable-next-line no-await-in-loop
      const result = await publishOne(connection, eventName, record, index);

      results.push(result);
      ux.log(formatResultLine(result, eventName));
    }

    if (results.some((result) => !result.success)) {
      process.exitCode = 1;
    }

    return results;
  }
}

const readEvents = async (payload: string): Promise<Array<Record<string, unknown>>> => {
  if (isInlinePayload(payload)) {
    return toEventRecords(parsePayload(payload, messages.getMessage('label.inlinePayload')), messages.getMessage('label.inlinePayload'));
  }

  const path = resolve(payload);
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw messages.createError('error.payloadNotFound', [path]);
  }

  return toEventRecords(parsePayload(text, path), path);
};

/**
 * Publishing is a plain REST insert on the `__e` object. There is no
 * pre-publish describe: an unknown event or a bad field comes back as an API
 * error, which reads well enough on its own.
 */
const publishOne = async (
  connection: Connection,
  eventName: string,
  record: Record<string, unknown>,
  index: number
): Promise<PublishResult> => {
  try {
    const outcome = (await connection.sobject(eventName).create(record)) as CreateOutcome;

    return toPublishResult(index, outcome);
  } catch (error) {
    return toFailedResult(index, error);
  }
};

const formatResultLine = (result: PublishResult, eventName: string): string =>
  result.success
    ? `${chalk.green('✓')} ${messages.getMessage('info.published', [String(result.index + 1), eventName, result.id ?? ''])}`
    : `${chalk.red('✗')} ${messages.getMessage('info.failed', [String(result.index + 1), (result.errors ?? []).join('; ')])}`;
