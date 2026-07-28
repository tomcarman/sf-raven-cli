import { Args } from '@oclif/core';
import { Messages } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { buildRecordTarget, isRecordId, launchBrowser, type OpenTarget } from '../../shared/open.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.open');

export type RavenOpenResult = {
  thing: string;
  kind: OpenTarget['kind'];
  name: string;
  path: string;
  url: string;
  opened: boolean;
};

export default class RavenOpen extends SfCommand<RavenOpenResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly args = {
    thing: Args.string({
      description: messages.getMessage('args.thing.description'),
      required: true,
    }),
  };

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
    }),
    'url-only': Flags.boolean({
      summary: messages.getMessage('flags.url-only.summary'),
      char: 'r',
      default: false,
    }),
  };

  public async run(): Promise<RavenOpenResult> {
    const { args, flags } = await this.parse(RavenOpen);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const org = flags['target-org'];

    const target = resolveTarget(args.thing);

    if (target == null) {
      throw messages.createError('error.notResolvable', [args.thing, messages.getMessage('label.categories')]);
    }

    const url = await org.getFrontDoorUrl(target.path);

    if (flags['url-only']) {
      ux.log(url);

      return { thing: args.thing, kind: target.kind, name: target.name, path: target.path, url, opened: false };
    }

    ux.log(messages.getMessage('info.opening', [messages.getMessage(`label.kind.${target.kind}`), target.name]));
    await launchBrowser(url);

    return { thing: args.thing, kind: target.kind, name: target.name, path: target.path, url, opened: true };
  }
}

const resolveTarget = (thing: string): OpenTarget | undefined =>
  isRecordId(thing) ? buildRecordTarget(thing) : undefined;
