import select from '@inquirer/select';
import { Args } from '@oclif/core';
import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import {
  buildAliasTarget,
  buildRecordTarget,
  buildSObjectTarget,
  isRecordId,
  launchBrowser,
  matchSObjects,
  type OpenTarget,
  type SObjectSummary,
} from '../../shared/open.js';
import { findAlias, mergeAliases, type AliasDefinition } from '../../shared/openAliases.js';
import { readRavenPluginConfig } from '../../shared/pluginConfig.js';
import { isPromptForceCloseError } from '../../shared/pull.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.open');

type SelectPrompt = <Value>(config: { message: string; choices: readonly unknown[]; pageSize?: number }) => Promise<Value>;

const selectPrompt = select as unknown as SelectPrompt;

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

    const aliases = mergeAliases((await readRavenPluginConfig(process.cwd())).open?.aliases);
    const target = await resolveTarget(args.thing, org.getConnection(), aliases, ux);

    if (target == null) {
      throw messages.createError('error.notResolvable', [args.thing, messages.getMessage('label.categories')]);
    }

    const url = await org.getFrontDoorUrl(target.path);
    const base = { thing: args.thing, kind: target.kind, name: target.name, path: target.path, url };

    if (flags['url-only']) {
      ux.log(url);

      return { ...base, opened: false };
    }

    ux.log(messages.getMessage('info.opening', [messages.getMessage(`label.kind.${target.kind}`), target.name]));
    await launchBrowser(url);

    return { ...base, opened: true };
  }
}

/** Record Id, then sobject, then Setup alias - first tier to match wins. */
const resolveTarget = async (
  thing: string,
  connection: Connection,
  aliases: Readonly<Record<string, AliasDefinition>>,
  ux: Ux
): Promise<OpenTarget | undefined> => {
  if (isRecordId(thing)) {
    return buildRecordTarget(thing);
  }

  const sobject = await resolveSObject(thing, connection, ux);

  if (sobject != null) {
    return sobject;
  }

  const alias = findAlias(thing, aliases);

  return alias == null ? undefined : buildAliasTarget(alias.alias, alias.path);
};

const resolveSObject = async (thing: string, connection: Connection, ux: Ux): Promise<OpenTarget | undefined> => {
  ux.spinner.start(messages.getMessage('info.resolving'));

  let matches: SObjectSummary[];

  try {
    matches = matchSObjects(thing, await listSObjects(connection));
  } finally {
    ux.spinner.stop();
  }

  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length === 1) {
    return buildSObjectTarget(matches[0].name);
  }

  const chosen = await pickSObject(matches);

  return chosen == null ? undefined : buildSObjectTarget(chosen);
};

const listSObjects = async (connection: Connection): Promise<SObjectSummary[]> => {
  const { sobjects } = await connection.describeGlobal();

  return sobjects.map((sobject) => ({ name: sobject.name, label: sobject.label }));
};

const pickSObject = async (matches: readonly SObjectSummary[]): Promise<string | undefined> => {
  try {
    return await selectPrompt<string>({
      message: messages.getMessage('prompt.selectSObject'),
      choices: matches.map((match) => ({ name: `${match.label} (${match.name})`, value: match.name })),
      pageSize: 10,
    });
  } catch (error) {
    if (isPromptForceCloseError(error)) {
      return undefined;
    }

    throw error;
  }
};
