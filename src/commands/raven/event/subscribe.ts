import { SfCommand, Flags, Ux } from '@salesforce/sf-plugins-core';
import { Messages, StreamingClient } from '@salesforce/core';
import type { JsonMap } from '@salesforce/ts-types';
import { Duration } from '@salesforce/kit';
import * as emoji from 'node-emoji';
import {
  buildErrorLine,
  buildEventLine,
  buildStatusLine,
  eventSubscribeFlagError,
  resolveEventChannel,
  serializeLine,
  subscribeTimeoutMinutes,
  type SubscribeLine,
} from '../../../shared/eventSubscribe.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.event.subscribe');

export type EventSubscribeResult = {
  status: string;
};

export default class EventSubscribe extends SfCommand<EventSubscribeResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: true,
    }),
    event: Flags.string({
      summary: messages.getMessage('flags.event.summary'),
      char: 'e',
      required: true,
    }),
    // eslint-disable-next-line sf-plugin/flag-min-max-default -- undefined means no replay
    replayid: Flags.integer({
      summary: messages.getMessage('flags.replayid.summary'),
      char: 'r',
      min: -2,
    }),
    // eslint-disable-next-line sf-plugin/flag-min-max-default -- undefined picks the per-mode default
    timeout: Flags.integer({
      summary: messages.getMessage('flags.timeout.summary'),
      char: 't',
      // The streaming client rejects subscribe waits under 3 minutes. The
      // terminal-mode maximum of 30 is checked in eventSubscribeFlagError,
      // because --ndjson lifts it.
      min: 3,
    }),
    ndjson: Flags.boolean({
      summary: messages.getMessage('flags.ndjson.summary'),
      default: false,
    }),
  };

  public async run(): Promise<EventSubscribeResult> {
    const { flags } = await this.parse(EventSubscribe);
    const ndjson = flags.ndjson;

    const flagError = eventSubscribeFlagError({ ndjson, json: this.jsonEnabled(), timeout: flags.timeout });

    if (flagError) {
      throw messages.createError(flagError);
    }

    const ux = new Ux({ jsonEnabled: this.jsonEnabled() || ndjson });
    const emit = ndjson ? writeLine : undefined;
    const channel = resolveEventChannel(flags.event);

    // Set up stream client and stream processor

    ux.spinner.start(`${emoji.get('electric_plug')} Connecting to org`);

    const streamProcessor = (message: JsonMap): { completed: boolean } => {
      if (emit != null) {
        emit(buildEventLine(channel, message, new Date()));
      } else {
        ux.log(JSON.stringify(message, null, 2) + '\n');
      }
      return {
        completed: false,
      };
    };

    const options = new StreamingClient.DefaultOptions(flags['target-org'], channel, streamProcessor);
    options.setSubscribeTimeout(Duration.minutes(subscribeTimeoutMinutes(flags.timeout, ndjson)));

    // Connect to the org

    const asyncStatusClient = await StreamingClient.create(options);

    process.removeAllListeners('SIGINT');
    process.once('SIGINT', () => {
      ux.log(messages.getMessage('info.exiting'));
      process.exit(130);
    });

    await asyncStatusClient.handshake();

    ux.spinner.stop();

    // Set the relay id if one has been supplied

    if (flags.replayid != null) {
      ux.log(`${emoji.get('leftwards_arrow_with_hook')}  Replaying from ${flags.replayid}`);
      asyncStatusClient.replay(flags.replayid);
    }

    // Start listening for events

    ux.log(`${emoji.get('ear')} Listening for events on ${channel}...\n`);

    try {
      await asyncStatusClient.subscribe(async (): Promise<void> => {
        // Runs once the subscription is confirmed.
        emit?.(buildStatusLine('connected'));
        return Promise.resolve();
      });
    } catch (error) {
      if (emit != null && isSubscribeTimeoutError(error)) {
        emit(buildStatusLine('timeout'));
      } else {
        throw error;
      }
    }

    return {
      status: 'Exiting',
    };
  }

  protected async catch(error: Error): Promise<never> {
    if (this.argv.includes('--ndjson') && !this.argv.includes('--json')) {
      writeLine(buildErrorLine(error.message));
      return this.exit(1);
    }

    return super.catch(error);
  }
}

const writeLine = (line: SubscribeLine): void => {
  process.stdout.write(`${serializeLine(line)}\n`);
};

const isSubscribeTimeoutError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'GenericTimeoutError';
