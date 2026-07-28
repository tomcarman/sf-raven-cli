import select from '@inquirer/select';
import { Args } from '@oclif/core';
import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import {
  buildAliasTarget,
  buildApexClassTarget,
  buildFlowTarget,
  buildRecordTarget,
  buildSObjectTarget,
  candidateLabel,
  fuzzyCandidates,
  launchBrowser,
  matchSObjects,
  type OpenCandidate,
  type OpenTarget,
  type SObjectSummary,
} from '../../shared/open.js';
import { findAlias, mergeAliases, type AliasDefinition } from '../../shared/openAliases.js';
import { readRavenPluginConfig } from '../../shared/pluginConfig.js';
import { isPromptForceCloseError } from '../../shared/pull.js';
import { escapeSoqlString, isValidSalesforceId } from '../../shared/query.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.open');

type SelectPrompt = <Value>(config: { message: string; choices: readonly unknown[]; pageSize?: number }) => Promise<Value>;

const selectPrompt = select as unknown as SelectPrompt;

export type RavenOpenResult = {
  thing: string;
  opened: boolean;
  /** Absent when a picker was dismissed without choosing anything. */
  kind?: OpenTarget['kind'];
  name?: string;
  path?: string;
  url?: string;
};

type Resolution =
  | { status: 'resolved'; target: OpenTarget }
  | { status: 'cancelled' }
  | { status: 'unresolved' };

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
    const resolution = await resolveTarget(args.thing, org.getConnection(), aliases, ux);

    if (resolution.status === 'cancelled') {
      ux.log(messages.getMessage('info.noSelection'));

      return { thing: args.thing, opened: false };
    }

    if (resolution.status === 'unresolved') {
      throw messages.createError('error.notResolvable', [args.thing, messages.getMessage('label.categories')]);
    }

    const { target } = resolution;
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

const resolveTarget = async (
  thing: string,
  connection: Connection,
  aliases: Readonly<Record<string, AliasDefinition>>,
  ux: Ux
): Promise<Resolution> => {
  if (isValidSalesforceId(thing)) {
    return { status: 'resolved', target: buildRecordTarget(thing) };
  }

  const candidates = await findCandidates(thing, connection, aliases, ux);

  if (candidates.length === 0) {
    return { status: 'unresolved' };
  }

  if (candidates.length === 1) {
    return { status: 'resolved', target: candidates[0].target };
  }

  const chosen = await pickCandidate(candidates);

  return chosen == null ? { status: 'cancelled' } : { status: 'resolved', target: chosen };
};

/**
 * Runs the exact tiers in precedence order - sObject, Setup alias, then metadata
 * by name - and only sweeps for near misses once all of them have come up empty.
 */
const findCandidates = async (
  thing: string,
  connection: Connection,
  aliases: Readonly<Record<string, AliasDefinition>>,
  ux: Ux
): Promise<OpenCandidate[]> => {
  ux.spinner.start(messages.getMessage('info.resolving'));

  try {
    const sobjects = await listSObjects(connection);
    const sobjectMatches = matchSObjects(thing, sobjects);

    if (sobjectMatches.length > 0) {
      return sobjectMatches.map(toSObjectCandidate);
    }

    const alias = findAlias(thing, aliases);

    if (alias != null) {
      return [{ label: alias.alias, target: buildAliasTarget(alias.alias, alias.path) }];
    }

    const metadata = await findMetadata(connection, thing);

    if (metadata.length > 0) {
      return metadata;
    }

    return fuzzyCandidates(thing, aliases, sobjects, messages.getMessage('label.kind.alias'));
  } finally {
    ux.spinner.stop();
  }
};

const toSObjectCandidate = (sobject: SObjectSummary): OpenCandidate => ({
  label: candidateLabel(sobject.label, sobject.name),
  target: buildSObjectTarget(sobject.name),
});

const listSObjects = async (connection: Connection): Promise<SObjectSummary[]> => {
  const { sobjects } = await connection.describeGlobal();

  return sobjects.map((sobject) => ({ name: sobject.name, label: sobject.label }));
};

type ApexClassRecord = { Id: string; Name: string };
type FlowDefinitionRecord = { DeveloperName: string; LatestVersionId: string | null };

/** Escapes SOQL's single-character and multi-character LIKE wildcards. */
const escapeSoqlLike = (value: string): string => escapeSoqlString(value).replace(/([%_])/g, '\\$1');

const findMetadata = async (connection: Connection, thing: string): Promise<OpenCandidate[]> => {
  const exact = escapeSoqlString(thing);
  const exactMatches = await queryMetadata(connection, `= '${exact}'`);

  if (exactMatches.length > 0) {
    return exactMatches;
  }

  return queryMetadata(connection, `LIKE '%${escapeSoqlLike(thing)}%'`);
};

const queryMetadata = async (connection: Connection, predicate: string): Promise<OpenCandidate[]> => {
  const [classes, flows] = await Promise.all([
    connection.tooling.query<ApexClassRecord>(`SELECT Id, Name FROM ApexClass WHERE Name ${predicate}`),
    connection.tooling.query<FlowDefinitionRecord>(
      `SELECT DeveloperName, LatestVersionId FROM FlowDefinition WHERE DeveloperName ${predicate}`
    ),
  ]);

  return [
    ...classes.records.map((record) => ({
      label: candidateLabel(record.Name, messages.getMessage('label.kind.apexClass')),
      target: buildApexClassTarget(record.Name, record.Id),
    })),
    // A definition with no version has nothing to open in Flow Builder.
    ...flows.records
      .filter((record): record is FlowDefinitionRecord & { LatestVersionId: string } => record.LatestVersionId != null)
      .map((record) => ({
        label: candidateLabel(record.DeveloperName, messages.getMessage('label.kind.flow')),
        target: buildFlowTarget(record.DeveloperName, record.LatestVersionId),
      })),
  ];
};

const pickCandidate = async (candidates: readonly OpenCandidate[]): Promise<OpenTarget | undefined> => {
  try {
    return await selectPrompt<OpenTarget>({
      message: messages.getMessage('prompt.selectCandidate'),
      choices: candidates.map((candidate) => ({ name: candidate.label, value: candidate.target })),
      pageSize: 10,
    });
  } catch (error) {
    if (isPromptForceCloseError(error)) {
      return undefined;
    }

    throw error;
  }
};
