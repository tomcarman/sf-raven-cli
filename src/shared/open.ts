import { spawn } from 'node:child_process';
import { aliasSearchTerms, setupPathPrefix, type AliasDefinition } from './openAliases.js';
import { isValidSalesforceId } from './query.js';

/**
 * What `raven open` decided the user meant, and where to send the browser.
 * `path` is relative to the org's instance URL and is handed to
 * `Org.getFrontDoorUrl` to be turned into a single-use frontdoor URL.
 */
export type OpenTarget = {
  kind: OpenTargetKind;
  /** What was matched, for the "opening X" message. */
  name: string;
  path: string;
};

export type OpenTargetKind = 'record' | 'sobject' | 'alias' | 'apexClass' | 'flow';

export const isRecordId = isValidSalesforceId;

/**
 * Records are opened by bare Id: Salesforce redirects `/<id>` to whichever view
 * is right for that object, so no describe round-trip is needed and tooling
 * objects work too.
 */
export const buildRecordTarget = (id: string): OpenTarget => ({ kind: 'record', name: id, path: `/${id}` });

export const buildSObjectTarget = (apiName: string): OpenTarget => ({
  kind: 'sobject',
  name: apiName,
  path: `${setupPathPrefix}ObjectManager/${apiName}/Details/view`,
});

export const buildAliasTarget = (alias: string, path: string): OpenTarget => ({
  kind: 'alias',
  name: alias,
  path: `${setupPathPrefix}${path}`,
});

export type SObjectSummary = {
  name: string;
  label: string;
};

/**
 * Strips the namespace prefix and the `__c`-style suffix so `invoice` finds
 * `acme__Invoice__c`.
 */
export const sobjectBaseName = (apiName: string): string => {
  const withoutSuffix = apiName.replace(/__[a-z]+$/i, '');
  const segments = withoutSuffix.split('__');

  return segments[segments.length - 1];
};

/**
 * Matches in tiers - API name, then API name ignoring namespace/suffix, then
 * label - and returns the first tier that hits anything, so an exact API name
 * is never diluted by label collisions.
 */
export const matchSObjects = (thing: string, sobjects: readonly SObjectSummary[]): SObjectSummary[] => {
  const needle = thing.toLowerCase();

  const tiers = [
    (sobject: SObjectSummary): boolean => sobject.name.toLowerCase() === needle,
    (sobject: SObjectSummary): boolean => sobjectBaseName(sobject.name).toLowerCase() === needle,
    (sobject: SObjectSummary): boolean => sobject.label.toLowerCase() === needle,
  ];

  for (const matches of tiers) {
    const hits = sobjects.filter(matches);

    if (hits.length > 0) {
      return hits;
    }
  }

  return [];
};

/**
 * Apex classes have no Lightning record page, so Setup's class list is opened
 * with the classic detail URL passed through its `address` parameter.
 */
export const buildApexClassTarget = (name: string, id: string): OpenTarget => ({
  kind: 'apexClass',
  name,
  path: `${setupPathPrefix}ApexClasses/page?address=%2F${id}`,
});

/** Flows open in Flow Builder at the version you would continue editing. */
export const buildFlowTarget = (developerName: string, latestVersionId: string): OpenTarget => ({
  kind: 'flow',
  name: developerName,
  path: `/builder_platform_interaction/flowBuilder.app?flowId=${latestVersionId}`,
});

export type OpenCandidate = {
  /** How the match is described in the picker. */
  label: string;
  target: OpenTarget;
};

/**
 * Last resort once every exact tier has missed: a case-insensitive substring
 * sweep over alias names and sObject names/labels. Deliberately no edit-distance
 * matching, so a typo fails loudly rather than opening the wrong page.
 */
export const fuzzyCandidates = (
  thing: string,
  aliases: Readonly<Record<string, AliasDefinition>>,
  sobjects: readonly SObjectSummary[]
): OpenCandidate[] => {
  const needle = thing.toLowerCase();
  const matchesNeedle = (term: string): boolean => term.toLowerCase().includes(needle);

  const aliasHits = [...aliasSearchTerms(aliases)]
    .filter(([, terms]) => terms.some(matchesNeedle))
    .map(([alias]) => ({
      label: `${alias} (Setup page)`,
      target: buildAliasTarget(alias, aliases[alias].path),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  const sobjectHits = sobjects
    .filter((sobject) => matchesNeedle(sobject.name) || matchesNeedle(sobject.label))
    .map((sobject) => ({
      label: `${sobject.label} (${sobject.name})`,
      target: buildSObjectTarget(sobject.name),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  return [...aliasHits, ...sobjectHits];
};

type OpenerCommand = { command: string; args: string[] };

export const openerCommand = (platform: NodeJS.Platform, url: string): OpenerCommand => {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      // The empty string is `start`'s title argument; without it a quoted URL is
      // treated as the window title and nothing opens.
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
};

export const launchBrowser = async (url: string, platform: NodeJS.Platform = process.platform): Promise<void> => {
  const { command, args } = openerCommand(platform, url);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
};
