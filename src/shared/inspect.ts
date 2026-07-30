import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Connection } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { escapeSoqlString } from './query.js';

type ToolingQueryResult<T> = { records: T[] };

type DependencyRecord = {
  MetadataComponentId: string;
  MetadataComponentName: string;
  MetadataComponentType: string;
  RefMetadataComponentId: string;
  RefMetadataComponentName: string;
  RefMetadataComponentType: string;
};

type IdRecord = { Id: string };
type DurableIdRecord = { DurableId: string };
type CustomFieldMetadataRecord = {
  Id: string;
  DeveloperName: string;
  EntityDefinition?: {
    QualifiedApiName?: string;
  };
};
type FlowDefinitionViewRecord = {
  ApiName: string;
  ActiveVersionId: string | null;
};

export type DependencyRef = {
  name: string;
  type: string;
};

type RawDependencyRef = DependencyRef & {
  id?: string;
};

export type DependencyResult = {
  outbound: DependencyRef[];
  inbound: DependencyRef[];
};

export type ToolingInspectConnection = {
  tooling: {
    query: <T>(soql: string) => Promise<ToolingQueryResult<T>>;
  };
  query: <T>(soql: string) => Promise<{ records: T[] }>;
};

export const dependencyComponentTypes = [
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'CustomObject',
  'CustomField',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
] as const;

export type DependencyComponentType = (typeof dependencyComponentTypes)[number];

export const resolveComponentId = async (
  connection: ToolingInspectConnection,
  type: DependencyComponentType,
  name: string
): Promise<string> => {
  switch (type) {
    case 'ApexClass': {
      const result = await connection.tooling.query<IdRecord>(`SELECT Id FROM ApexClass WHERE Name = '${name}' LIMIT 1`);
      return requireId(result.records[0]?.Id, type, name);
    }
    case 'ApexTrigger': {
      const result = await connection.tooling.query<IdRecord>(`SELECT Id FROM ApexTrigger WHERE Name = '${name}' LIMIT 1`);
      return requireId(result.records[0]?.Id, type, name);
    }
    case 'LightningComponentBundle': {
      const result = await connection.tooling.query<IdRecord>(`SELECT Id FROM LightningComponentBundle WHERE ApiName = '${name}' LIMIT 1`);
      return requireId(result.records[0]?.Id, type, name);
    }
    case 'AuraDefinitionBundle': {
      const result = await connection.tooling.query<IdRecord>(`SELECT Id FROM AuraDefinitionBundle WHERE ApiName = '${name}' LIMIT 1`);
      return requireId(result.records[0]?.Id, type, name);
    }
    case 'Flow': {
      const result = await connection.query<IdRecord>(`SELECT Id FROM FlowDefinitionView WHERE ApiName = '${name}' AND IsActive = true LIMIT 1`);
      return requireId(result.records[0]?.Id, type, name);
    }
    case 'CustomObject': {
      const result = await connection.query<DurableIdRecord>(`SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = '${name}' LIMIT 1`);
      return requireId(result.records[0]?.DurableId, type, name);
    }
    case 'CustomField': {
      const [sobject, field] = name.split('.');

      if (sobject == null || field == null) {
        throw new Error(`CustomField name must be in ObjectName.FieldName format (got: ${name})`);
      }

      if (!field.endsWith('__c')) {
        throw new Error(`'${name}' is a standard field. Dependency tracking is only available for custom fields.`);
      }

      // MetadataComponentDependency keys custom fields off the Tooling API CustomField Id
      // (the 00N... id), not FieldDefinition.DurableId. The CustomField DeveloperName is the
      // field's API name without the trailing __c.
      const developerName = field.slice(0, -'__c'.length);
      const result = await connection.tooling.query<IdRecord>(
        `SELECT Id FROM CustomField WHERE EntityDefinition.QualifiedApiName = '${sobject}' AND DeveloperName = '${developerName}' LIMIT 1`
      );
      return requireId(result.records[0]?.Id, type, name);
    }
    default:
      throw new Error(
        `Unsupported component type: ${String(type)}. Supported types: ${dependencyComponentTypes.join(', ')}`
      );
  }
};

export const queryDependencies = async (
  connection: ToolingInspectConnection,
  id: string
): Promise<DependencyResult> => {
  const outboundQuery = connection.tooling.query<DependencyRecord>(
    `SELECT RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE MetadataComponentId = '${id}' ORDER BY RefMetadataComponentType, RefMetadataComponentName`
  );

  const inboundQuery = connection.tooling.query<DependencyRecord>(
    `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${id}' ORDER BY MetadataComponentType, MetadataComponentName`
  );

  const [outboundResult, inboundResult] = await Promise.all([outboundQuery, inboundQuery]);
  const outbound = await enrichDependencyRefs(
    connection,
    outboundResult.records.map((r) => ({ id: r.RefMetadataComponentId, name: r.RefMetadataComponentName, type: r.RefMetadataComponentType }))
  );
  const inbound = await enrichDependencyRefs(
    connection,
    inboundResult.records.map((r) => ({ id: r.MetadataComponentId, name: r.MetadataComponentName, type: r.MetadataComponentType }))
  );

  return {
    outbound: dedupe(outbound),
    inbound: dedupe(inbound),
  };
};

export const queryInboundOnly = async (
  connection: ToolingInspectConnection,
  id: string
): Promise<DependencyRef[]> => {
  const result = await connection.tooling.query<DependencyRecord>(
    `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${id}' ORDER BY MetadataComponentType, MetadataComponentName`
  );

  const refs = await enrichDependencyRefs(
    connection,
    result.records.map((r) => ({ id: r.MetadataComponentId, name: r.MetadataComponentName, type: r.MetadataComponentType }))
  );

  return dedupe(refs);
};

const requireId = (id: string | undefined, type: string, name: string): string => {
  if (id == null) {
    throw new Error(`${type} '${name}' not found in this org.`);
  }

  return id;
};

const dedupe = (refs: DependencyRef[]): DependencyRef[] => {
  const seen = new Set<string>();

  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const enrichDependencyRefs = async (
  connection: ToolingInspectConnection,
  refs: RawDependencyRef[]
): Promise<DependencyRef[]> => {
  const [customFieldNames, activeFlowNames] = await Promise.all([queryCustomFieldNames(connection, refs), queryActiveFlowNames(connection, refs)]);

  return refs.map((ref) => {
    if (ref.type === 'CustomField' && ref.id != null) {
      return { type: ref.type, name: customFieldNames.get(ref.id) ?? ref.name };
    }

    if (ref.type === 'Flow') {
      const apiName = flowApiName(ref.name);
      return { type: ref.type, name: activeFlowNames.get(apiName) ?? ref.name };
    }

    return { type: ref.type, name: ref.name };
  });
};

const queryCustomFieldNames = async (
  connection: ToolingInspectConnection,
  refs: RawDependencyRef[]
): Promise<Map<string, string>> => {
  const ids = unique(refs.filter((ref) => ref.type === 'CustomField').map((ref) => ref.id).filter(isPresent));

  if (ids.length === 0) {
    return new Map<string, string>();
  }

  const result = await connection.tooling.query<CustomFieldMetadataRecord>(
    `SELECT Id, DeveloperName, EntityDefinition.QualifiedApiName FROM CustomField WHERE Id IN (${toSoqlStringList(ids)})`
  );

  return new Map(
    result.records
      .map((record): [string, string] | undefined => {
        const objectApiName = record.EntityDefinition?.QualifiedApiName ?? getFlatString(record, 'EntityDefinition.QualifiedApiName');

        if (objectApiName == null) {
          return undefined;
        }

        const fieldApiName = record.DeveloperName.endsWith('__c') ? record.DeveloperName : `${record.DeveloperName}__c`;
        return [record.Id, `${objectApiName}.${fieldApiName}`];
      })
      .filter(isPresent)
  );
};

const queryActiveFlowNames = async (
  connection: ToolingInspectConnection,
  refs: RawDependencyRef[]
): Promise<Map<string, string>> => {
  const flowNames = unique(refs.filter((ref) => ref.type === 'Flow').map((ref) => flowApiName(ref.name)));

  if (flowNames.length === 0) {
    return new Map<string, string>();
  }

  const result = await connection.query<FlowDefinitionViewRecord>(
    `SELECT ApiName, ActiveVersionId FROM FlowDefinitionView WHERE ApiName IN (${toSoqlStringList(flowNames)}) AND IsActive = true`
  );

  return new Map(result.records.filter((record) => record.ActiveVersionId != null).map((record) => [record.ApiName, record.ApiName]));
};

const flowApiName = (name: string): string => name.replace(/-\d+$/, '');

const toSoqlStringList = (values: string[]): string => values.map((value) => `'${escapeSoqlString(value)}'`).join(', ');

const unique = (values: string[]): string[] => [...new Set(values)];

const isPresent = <T>(value: T | null | undefined): value is T => value != null;

const getFlatString = (record: CustomFieldMetadataRecord, key: string): string | undefined => {
  const value = (record as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
};

const deepSearchTypes: Array<{ type: string; suffix: string }> = [
  { type: 'FlexiPage', suffix: '.flexipage-meta.xml' },
  { type: 'Layout', suffix: '.layout-meta.xml' },
  { type: 'Flow', suffix: '.flow-meta.xml' },
];

/**
 * Retrieves FlexiPages, Layouts, and Flows via the Metadata API and text-searches their
 * source for references to the given field. This catches declarative references that
 * MetadataComponentDependency does not track — notably FlexiPage and Layout field usage,
 * and references to standard fields.
 */
export const deepSearchReferences = async (
  connection: Connection,
  sobject: string,
  field: string
): Promise<DependencyRef[]> => {
  const output = mkdtempSync(join(tmpdir(), 'raven-deep-'));

  try {
    const componentSet = new ComponentSet(deepSearchTypes.map(({ type }) => ({ fullName: '*', type })));
    const retrieve = await componentSet.retrieve({ usernameOrConnection: connection, output });
    await retrieve.pollStatus({ frequency: Duration.seconds(2), timeout: Duration.minutes(10) });

    const fieldMatcher = tokenMatcher(field);
    const objectMatcher = tokenMatcher(sobject);
    const refs: DependencyRef[] = [];

    for (const filePath of walkFiles(output)) {
      const matchType = deepSearchTypes.find(({ suffix }) => filePath.endsWith(suffix));

      if (matchType == null) {
        continue;
      }

      const content = readFileSync(filePath, 'utf8');

      // Require both the field and the object to appear, so a same-named field on a
      // different object does not produce a false positive.
      if (fieldMatcher.test(content) && objectMatcher.test(content)) {
        const name = componentNameFromPath(filePath, matchType.suffix);
        // Layout fullNames are "Object-Label"; the dependency API reports just "Label",
        // so strip the object prefix to keep both sources consistent for dedup.
        const normalizedName =
          matchType.type === 'Layout' && name.startsWith(`${sobject}-`) ? name.slice(sobject.length + 1) : name;
        refs.push({ type: matchType.type, name: normalizedName });
      }
    }

    return dedupe(refs);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
};

/**
 * Builds a comparison key that collapses the label form a component name takes in the
 * dependency API (e.g. "My Flow: After Save") and the API name the deep search derives
 * from a filename (e.g. "My_Flow_After_Save"). Both reduce to the same lowercase
 * alphanumeric string.
 */
export const canonicalRefKey = (type: string, name: string): string => `${type}:${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

const tokenMatcher = (value: string): RegExp => new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(value)}(?![A-Za-z0-9_])`);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const componentNameFromPath = (filePath: string, suffix: string): string => {
  const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
  return fileName.endsWith(suffix) ? fileName.slice(0, -suffix.length) : fileName;
};

function* walkFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (statSync(fullPath).isFile()) {
      yield fullPath;
    }
  }
}
