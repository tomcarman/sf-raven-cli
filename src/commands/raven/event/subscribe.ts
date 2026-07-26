import { SfCommand, Flags, Ux } from '@salesforce/sf-plugins-core';
import { Messages, StreamingClient } from '@salesforce/core';
import type { JsonMap } from '@salesforce/ts-types';
import { Duration } from '@salesforce/kit';
import * as emoji from 'node-emoji';

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
    replayid: Flags.integer({
      summary: messages.getMessage('flags.replayid.summary'),
      char: 'r',
    }),
    timeout: Flags.integer({
      summary: messages.getMessage('flags.timeout.summary'),
      char: 't',
      min: 1,
      max: 30,
      default: 3,
    }),
  };

  public async run(): Promise<EventSubscribeResult> {
    const { flags } = await this.parse(EventSubscribe);

    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    // Set up stream client and stream processor

    ux.spinner.start(`${emoji.get('electric_plug')} Connecting to org`);

    const streamProcessor = (message: JsonMap): { completed: boolean } => {
      ux.log(JSON.stringify(message, null, 2) + '\n');
      return {
        completed: false,
      };
    };

    const options = new StreamingClient.DefaultOptions(flags['target-org'], flags.event, streamProcessor);

    if (flags.timeout != null) {
      options.setSubscribeTimeout(Duration.minutes(flags.timeout));
    }

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

    ux.log(`${emoji.get('ear')} Listening for events...\n`);

    await asyncStatusClient.subscribe(async (): Promise<void> => {
      // Nothing to do
    });

    return {
      status: 'Exiting',
    };
  }
}
