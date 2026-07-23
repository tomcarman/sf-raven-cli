import { writeFileSync } from 'node:fs';
import { XMLBuilder } from 'fast-xml-parser';
import { ensureArray } from '@salesforce/kit';
import { SourceComponent, type MetadataComponent } from '@salesforce/source-deploy-retrieve';
import { getLocalMetadataComponents } from './pull.js';

export type ProfileMetadata = Record<string, unknown> & { fullName?: string };

export type ProfileReader = (profileNames: string[]) => Promise<ProfileMetadata[]>;

export type ProfileSyncOptions = {
  projectRoot: string;
  profileNames?: string[];
  readProfiles: ProfileReader;
};

export type SyncedProfile = {
  name: string;
  path: string;
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
};

type ProfileEntry = Record<string, unknown>;

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

  const profilePaths = profileNames.map((profileName): [string, string] => {
    const profilePath = trackedProfilePaths.get(profileName);

    if (profilePath == null) {
      throw new Error(`Profile "${profileName}" is not tracked in local source.`);
    }

    return [profileName, profilePath];
  });

  const inventory = buildComponentInventory(localComponents);
  const { orgProfiles, failures } = await readProfilesInBatches(profileNames, options.readProfiles);
  const result: ProfileSyncResult = { synced: [], skipped: [], failed: [] };

  for (const [profileName, profilePath] of profilePaths) {
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

    writeFileSync(profilePath, serializeProfile(filterProfile(orgProfile, inventory)));
    result.synced.push({ name: profileName, path: profilePath });
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

const toOrderedEntry = (entry: ProfileEntry): ProfileEntry => {
  const ordered: ProfileEntry = {};

  for (const childName of Object.keys(entry).sort(compareAscii)) {
    const childValue = entry[childName];
    ordered[childName] = isEntryValue(childValue) ? ensureArray(childValue).map(toOrderedEntry) : childValue;
  }

  return ordered;
};

const compareEntriesBy =
  (sortKeys: string[]) =>
  (left: ProfileEntry, right: ProfileEntry): number => {
    const tieBreakNames = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort(compareAscii);

    for (const childName of [...sortKeys, ...tieBreakNames]) {
      const comparison = compareAscii(String(left[childName] ?? ''), String(right[childName] ?? ''));

      if (comparison !== 0) {
        return comparison;
      }
    }

    return 0;
  };

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
