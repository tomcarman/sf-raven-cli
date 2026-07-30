export type AliasDefinition = {
  path: string;
  synonyms?: string[];
};

/** Setup alias paths are all relative to this. */
export const setupPathPrefix = '/lightning/setup/';

/**
 * Shortcuts for the Setup pages worth typing a name for. Keys and synonyms are
 * matched case-insensitively; paths are relative to `setupPathPrefix`.
 */
export const builtInAliases: Readonly<Record<string, AliasDefinition>> = {
  users: { path: 'ManageUsers/home' },
  profiles: { path: 'EnhancedProfiles/home' },
  'perm-sets': { path: 'PermSets/home', synonyms: ['permissions', 'permission-sets', 'ps'] },
  'perm-set-groups': {
    path: 'PermSetGroups/home',
    synonyms: ['permission-set-groups', 'permissionsetgroups', 'psg'],
  },
  roles: { path: 'Roles/home' },
  'public-groups': { path: 'PublicGroups/home' },
  queues: { path: 'Queues/home' },
  flows: { path: 'Flows/home' },
  'process-builder': { path: 'ProcessAutomation/home' },
  'apex-classes': { path: 'ApexClasses/home', synonyms: ['classes'] },
  'apex-triggers': { path: 'ApexTriggers/home', synonyms: ['triggers'] },
  'apex-jobs': { path: 'AsyncApexJobs/home' },
  'scheduled-jobs': { path: 'ScheduledJobs/home' },
  'debug-logs': { path: 'ApexDebugLogs/home' },
  'deploy-status': { path: 'DeployStatus/home', synonyms: ['deploy'] },
  'package-manager': { path: 'Package/home' },
  'object-manager': { path: 'ObjectManager/home' },
  'custom-labels': { path: 'ExternalStrings/home' },
  'custom-settings': { path: 'CustomSettings/home' },
  'custom-metadata': { path: 'CustomMetadata/home' },
  'email-deliverability': { path: 'OrgEmailSettings/home' },
  'login-history': { path: 'OrgLoginHistory/home' },
  'setup-audit': { path: 'SecurityEvents/home' },
  'connected-apps': { path: 'ConnectedApplication/home' },
  setup: { path: 'SetupOneHome/home', synonyms: ['home'] },
};

/**
 * Layers project-defined aliases over the built-ins. User definitions win on
 * conflict, and are stored as a bare `SetupPath/home` string.
 */
export const mergeAliases = (
  userAliases: Readonly<Record<string, string>> | undefined
): Record<string, AliasDefinition> => {
  const merged: Record<string, AliasDefinition> = { ...builtInAliases };

  for (const [alias, path] of Object.entries(userAliases ?? {})) {
    if (typeof path === 'string' && path.length > 0) {
      merged[alias.toLowerCase()] = { path };
    }
  }

  return merged;
};

export type AliasMatch = {
  alias: string;
  path: string;
};

export const findAlias = (
  thing: string,
  aliases: Readonly<Record<string, AliasDefinition>>
): AliasMatch | undefined => {
  const needle = thing.toLowerCase();
  const entries = Object.entries(aliases);

  const byKey = entries.find(([alias]) => alias.toLowerCase() === needle);

  if (byKey != null) {
    return { alias: byKey[0], path: byKey[1].path };
  }

  const bySynonym = entries.find(([, definition]) =>
    (definition.synonyms ?? []).some((synonym) => synonym.toLowerCase() === needle)
  );

  return bySynonym == null ? undefined : { alias: bySynonym[0], path: bySynonym[1].path };
};

/** Every name an alias answers to, used by the fuzzy fallback. */
export const aliasSearchTerms = (aliases: Readonly<Record<string, AliasDefinition>>): Map<string, string[]> =>
  new Map(Object.entries(aliases).map(([alias, definition]) => [alias, [alias, ...(definition.synonyms ?? [])]]));
