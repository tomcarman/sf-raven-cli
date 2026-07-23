import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { ensureArray } from '@salesforce/kit';
import { SourceComponent, type MetadataComponent } from '@salesforce/source-deploy-retrieve';
import { getDefaultPackageDirectoryPath, getLocalMetadataComponents } from './pull.js';

export type ProfileMetadata = Record<string, unknown> & { fullName?: string };

export type ProfileReader = (profileNames: string[]) => Promise<ProfileMetadata[]>;

export type ProfileSyncOptions = {
  projectRoot: string;
  profileNames?: string[];
  readProfiles: ProfileReader;
  dryRun?: boolean;
  adoptUntracked?: boolean;
};

export type SectionChanges = {
  section: string;
  added: number;
  removed: number;
  modified: number;
};

export type SyncedProfile = {
  name: string;
  path: string;
  changed: boolean;
  adopted?: boolean;
  changes: SectionChanges[];
};

export type SkippedProfile = {
  name: string;
};

export type FailedProfile = {
  name: string;
  error: string;
};

export type ProfileSyncResult = {
  synced: SyncedProfile[];
  skipped: SkippedProfile[];
  failed: FailedProfile[];
  dryRun: boolean;
  drifted: boolean;
};

type ProfileEntry = Record<string, unknown>;

type ProfileTarget = {
  profileName: string;
  profilePath: string;
  adopted: boolean;
};

type ComponentInventory = Map<string, Set<string>>;

type SectionRule = {
  sortKeys: string[];
  isEntryKept?: (entry: ProfileEntry, inventory: ComponentInventory) => boolean;
};

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';
const METADATA_NAMESPACE = 'http://soap.sforce.com/2006/04/metadata';

// Hard API limit: readMetadata accepts at most 10 fullNames per call.
const READ_BATCH_SIZE = 10;

export const syncProfiles = async (options: ProfileSyncOptions): Promise<ProfileSyncResult> => {
  const localComponents = getLocalMetadataComponents(options.projectRoot);
  const trackedProfilePaths = getTrackedProfilePaths(localComponents);
  const profileNames = options.profileNames ?? Array.from(trackedProfilePaths.keys()).sort(compareAscii);

  const adoptionDir = options.adoptUntracked ? getAdoptionDir(options.projectRoot, trackedProfilePaths) : undefined;

  const profileTargets = profileNames.map((profileName): ProfileTarget => {
    const trackedPath = trackedProfilePaths.get(profileName);

    if (trackedPath != null) {
      return { profileName, profilePath: trackedPath, adopted: false };
    }

    if (adoptionDir == null) {
      throw new Error(`Profile "${profileName}" is not tracked in local source.`);
    }

    return { profileName, profilePath: join(adoptionDir, `${profileName}.profile-meta.xml`), adopted: true };
  });

  const inventory = buildComponentInventory(localComponents);
  const dryRun = options.dryRun ?? false;
  const { orgProfiles, failures } = await readProfilesInBatches(profileNames, options.readProfiles);
  const result: ProfileSyncResult = { synced: [], skipped: [], failed: [], dryRun, drifted: false };

  for (const { profileName, profilePath, adopted } of profileTargets) {
    const failure = failures.get(profileName);

    if (failure != null) {
      result.failed.push({ name: profileName, error: failure });
      continue;
    }

    const orgProfile = orgProfiles.get(profileName);

    if (orgProfile == null) {
      result.skipped.push({ name: profileName });
      continue;
    }

    const filteredProfile = filterProfile(orgProfile, inventory);
    const newContent = serializeProfile(filteredProfile);
    const oldContent = adopted ? undefined : readFileSync(profilePath, 'utf8');
    const changed = newContent !== oldContent;

    if (changed && !dryRun) {
      if (adopted) {
        mkdirSync(dirname(profilePath), { recursive: true });
      }

      writeFileSync(profilePath, newContent);
    }

    result.drifted = result.drifted || changed;
    result.synced.push({
      name: profileName,
      path: profilePath,
      changed,
      ...(adopted ? { adopted } : {}),
      changes: changed ? diffProfiles(oldContent == null ? {} : parseProfileXml(oldContent), filteredProfile) : [],
    });
  }

  return result;
};

const readProfilesInBatches = async (
  profileNames: string[],
  readProfiles: ProfileReader
): Promise<{ orgProfiles: Map<string, ProfileMetadata>; failures: Map<string, string> }> => {
  const orgProfiles = new Map<string, ProfileMetadata>();
  const failures = new Map<string, string>();
  const batches: string[][] = [];

  for (let start = 0; start < profileNames.length; start += READ_BATCH_SIZE) {
    batches.push(profileNames.slice(start, start + READ_BATCH_SIZE));
  }

  await Promise.all(
    batches.map(async (batchNames) => {
      try {
        for (const profile of await readProfiles(batchNames)) {
          if (profile.fullName != null) {
            orgProfiles.set(profile.fullName, profile);
          }
        }
      } catch (error) {
        for (const profileName of batchNames) {
          failures.set(profileName, error instanceof Error ? error.message : String(error));
        }
      }
    })
  );

  return { orgProfiles, failures };
};

// Adopted profiles join the folder the default package directory's tracked profiles already
// use, falling back to the conventional main/default/profiles when it has none.
const getAdoptionDir = (projectRoot: string, trackedProfilePaths: Map<string, string>): string => {
  const defaultPackagePath = join(projectRoot, getDefaultPackageDirectoryPath(projectRoot));

  for (const profilePath of trackedProfilePaths.values()) {
    if (dirname(profilePath).startsWith(defaultPackagePath + sep)) {
      return dirname(profilePath);
    }
  }

  return join(defaultPackagePath, 'main', 'default', 'profiles');
};

const getTrackedProfilePaths = (localComponents: MetadataComponent[]): Map<string, string> => {
  const trackedProfilePaths = new Map<string, string>();

  for (const component of localComponents) {
    if (component.type.name === 'Profile' && component instanceof SourceComponent && component.xml != null) {
      trackedProfilePaths.set(component.fullName, component.xml);
    }
  }

  return trackedProfilePaths;
};

const buildComponentInventory = (localComponents: MetadataComponent[]): ComponentInventory => {
  const inventory: ComponentInventory = new Map();

  const add = (metadataTypeName: string, fullName: string): void => {
    const fullNames = inventory.get(metadataTypeName) ?? new Set<string>();
    fullNames.add(fullName);
    inventory.set(metadataTypeName, fullNames);
  };

  for (const component of localComponents) {
    add(component.type.name, component.fullName);

    if (component instanceof SourceComponent) {
      for (const child of component.getChildren()) {
        add(child.type.name, child.fullName);
      }
    }
  }

  return inventory;
};

const isTracked = (inventory: ComponentInventory, metadataTypeName: string, fullName: string): boolean =>
  inventory.get(metadataTypeName)?.has(fullName) ?? false;

const referencesTracked =
  (metadataTypeName: string, childName: string) =>
  (entry: ProfileEntry, inventory: ComponentInventory): boolean =>
    isTracked(inventory, metadataTypeName, String(entry[childName] ?? ''));

// Keep object.field if the object or the field itself is tracked, preserving standard-field FLS for tracked objects.
const isFieldPermissionKept = (entry: ProfileEntry, inventory: ComponentInventory): boolean => {
  const field = String(entry['field'] ?? '');
  const objectName = field.split('.')[0];

  return isTracked(inventory, 'CustomObject', objectName) || isTracked(inventory, 'CustomField', field);
};

// Sections without a rule, or without an isEntryKept predicate (userPermissions, loginIpRanges,
// custom, userLicense, ...), are always kept in full.
const sectionRules: Record<string, SectionRule> = {
  applicationVisibilities: { sortKeys: ['application'], isEntryKept: referencesTracked('CustomApplication', 'application') },
  categoryGroupVisibilities: { sortKeys: ['dataCategoryGroup'], isEntryKept: referencesTracked('DataCategoryGroup', 'dataCategoryGroup') },
  classAccesses: { sortKeys: ['apexClass'], isEntryKept: referencesTracked('ApexClass', 'apexClass') },
  customMetadataTypeAccesses: { sortKeys: ['name'], isEntryKept: referencesTracked('CustomObject', 'name') },
  customPermissions: { sortKeys: ['name'], isEntryKept: referencesTracked('CustomPermission', 'name') },
  customSettingAccesses: { sortKeys: ['name'], isEntryKept: referencesTracked('CustomObject', 'name') },
  externalDataSourceAccesses: { sortKeys: ['externalDataSource'], isEntryKept: referencesTracked('ExternalDataSource', 'externalDataSource') },
  fieldPermissions: { sortKeys: ['field'], isEntryKept: isFieldPermissionKept },
  flowAccesses: { sortKeys: ['flow'], isEntryKept: referencesTracked('Flow', 'flow') },
  layoutAssignments: { sortKeys: ['layout', 'recordType'], isEntryKept: referencesTracked('Layout', 'layout') },
  loginIpRanges: { sortKeys: ['startAddress', 'endAddress'] },
  objectPermissions: { sortKeys: ['object'], isEntryKept: referencesTracked('CustomObject', 'object') },
  pageAccesses: { sortKeys: ['apexPage'], isEntryKept: referencesTracked('ApexPage', 'apexPage') },
  recordTypeVisibilities: { sortKeys: ['recordType'], isEntryKept: referencesTracked('RecordType', 'recordType') },
  tabVisibilities: { sortKeys: ['tab'], isEntryKept: referencesTracked('CustomTab', 'tab') },
  userPermissions: { sortKeys: ['name'] },
};

const filterProfile = (profile: ProfileMetadata, inventory: ComponentInventory): ProfileMetadata => {
  const filtered: ProfileMetadata = {};

  for (const [sectionName, value] of Object.entries(profile)) {
    if (sectionName === 'fullName') {
      continue;
    }

    const isEntryKept = sectionRules[sectionName]?.isEntryKept;

    if (isEntryKept != null && isEntryValue(value)) {
      const keptEntries = ensureArray(value).filter((entry) => isEntryKept(entry, inventory));

      if (keptEntries.length > 0) {
        filtered[sectionName] = keptEntries;
      }
    } else {
      filtered[sectionName] = value;
    }
  }

  return filtered;
};

const parseProfileXml = (profileXml: string): ProfileMetadata => {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });
  const parsed = parser.parse(profileXml) as Record<string, unknown>;
  const profile = parsed['Profile'];

  return isEntryValue(profile) && !Array.isArray(profile) ? profile : {};
};

const diffProfiles = (oldProfile: ProfileMetadata, newProfile: ProfileMetadata): SectionChanges[] => {
  const changes: SectionChanges[] = [];

  for (const sectionName of sortedKeyUnion(oldProfile, newProfile)) {
    const sectionChanges = diffSection(sectionName, oldProfile[sectionName], newProfile[sectionName]);

    if (sectionChanges.added > 0 || sectionChanges.removed > 0 || sectionChanges.modified > 0) {
      changes.push(sectionChanges);
    }
  }

  return changes;
};

const diffSection = (sectionName: string, oldValue: unknown, newValue: unknown): SectionChanges => {
  const sectionChanges: SectionChanges = { section: sectionName, added: 0, removed: 0, modified: 0 };

  if (isEntryValue(oldValue) || isEntryValue(newValue)) {
    const oldEntries = toEntryMap(sectionName, oldValue);
    const newEntries = toEntryMap(sectionName, newValue);

    for (const [identity, comparable] of newEntries) {
      const oldComparable = oldEntries.get(identity);

      if (oldComparable == null) {
        sectionChanges.added += 1;
      } else if (oldComparable !== comparable) {
        sectionChanges.modified += 1;
      }
    }

    for (const identity of oldEntries.keys()) {
      if (!newEntries.has(identity)) {
        sectionChanges.removed += 1;
      }
    }
  } else if (oldValue == null) {
    sectionChanges.added = 1;
  } else if (newValue == null) {
    sectionChanges.removed = 1;
  } else if (String(oldValue) !== String(newValue)) {
    sectionChanges.modified = 1;
  }

  return sectionChanges;
};

// Entries are identified by the section's sort-key values; when a section has no known
// sort keys, the whole entry is its identity, so a change counts as removed plus added.
const toEntryMap = (sectionName: string, value: unknown): Map<string, string> => {
  const entries = new Map<string, string>();

  if (!isEntryValue(value)) {
    return entries;
  }

  const sortKeys = sectionRules[sectionName]?.sortKeys;

  for (const entry of ensureArray(value)) {
    const comparable = JSON.stringify(toComparableEntry(entry));
    const identity = sortKeys == null ? comparable : sortKeys.map((sortKey) => String(entry[sortKey] ?? '')).join(' ');
    entries.set(identity, comparable);
  }

  return entries;
};

// Coerces leaf values to strings so parsed-from-disk entries compare equal to org entries.
const toComparableEntry = (entry: ProfileEntry): ProfileEntry => mapEntry(entry, String);

const serializeProfile = (profile: ProfileMetadata): string => {
  const body: Record<string, unknown> = {};

  for (const sectionName of Object.keys(profile).sort(compareAscii)) {
    body[sectionName] = toCanonicalSection(sectionName, profile[sectionName]);
  }

  const builder = new XMLBuilder({
    format: true,
    indentBy: '    ',
    ignoreAttributes: false,
    suppressBooleanAttributes: false,
  });

  const builtXml = String(builder.build({ Profile: { '@_xmlns': METADATA_NAMESPACE, ...body } }));

  return XML_DECL + handleSpecialEntities(builtXml);
};

const toCanonicalSection = (sectionName: string, value: unknown): unknown => {
  if (!isEntryValue(value)) {
    return value;
  }

  return ensureArray(value).map(toOrderedEntry).sort(compareEntriesBy(sectionRules[sectionName]?.sortKeys ?? []));
};

const toOrderedEntry = (entry: ProfileEntry): ProfileEntry => mapEntry(entry, (leafValue) => leafValue);

const mapEntry = (entry: ProfileEntry, mapLeaf: (leafValue: unknown) => unknown): ProfileEntry => {
  const mapped: ProfileEntry = {};

  for (const childName of Object.keys(entry).sort(compareAscii)) {
    const childValue = entry[childName];
    mapped[childName] = isEntryValue(childValue)
      ? ensureArray(childValue).map((childEntry) => mapEntry(childEntry, mapLeaf))
      : mapLeaf(childValue);
  }

  return mapped;
};

const compareEntriesBy =
  (sortKeys: string[]) =>
  (left: ProfileEntry, right: ProfileEntry): number => {
    for (const childName of [...sortKeys, ...sortedKeyUnion(left, right)]) {
      const comparison = compareAscii(String(left[childName] ?? ''), String(right[childName] ?? ''));

      if (comparison !== 0) {
        return comparison;
      }
    }

    return 0;
  };

const sortedKeyUnion = (left: object, right: object): string[] =>
  Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort(compareAscii);

const isEntryValue = (value: unknown): value is ProfileEntry | ProfileEntry[] => typeof value === 'object' && value != null;

const compareAscii = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
};

// XMLBuilder escapes the leading & of numeric character references (e.g. &#160; -> &amp;#160;);
// undo that so entity-bearing values round-trip exactly as sf project retrieve writes them.
const handleSpecialEntities = (xml: string): string => xml.replace(/&amp;#(x?[\da-fA-F]+);/g, '&#$1;');
