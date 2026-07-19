import { Messages } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { canonicalRefKey, deepSearchReferences, queryInboundOnly, type DependencyRef, type ToolingInspectConnection } from '../../../shared/inspect.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.inspect.field');

type CustomFieldRecord = { Id: string };

type SourcedRef = DependencyRef & { source: string };

export type RavenInspectFieldResult = {
  sobject: string;
  field: string;
  references: SourcedRef[];
};

export default class RavenInspectField extends SfCommand<RavenInspectFieldResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: true,
    }),
    sobject: Flags.string({
      summary: messages.getMessage('flags.sobject.summary'),
      char: 's',
      required: true,
    }),
    field: Flags.string({
      summary: messages.getMessage('flags.field.summary'),
      char: 'f',
      required: true,
    }),
    deep: Flags.boolean({
      summary: messages.getMessage('flags.deep.summary'),
      default: false,
    }),
  };

  public async run(): Promise<RavenInspectFieldResult> {
    const { flags } = await this.parse(RavenInspectField);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const org = flags['target-org'];
    const conn = org.getConnection();
    const inspectConn = conn as unknown as ToolingInspectConnection;
    const { sobject, field, deep } = flags;
    const isCustomField = field.endsWith('__c');

    if (!isCustomField && !deep) {
      throw messages.createError('error.standardFieldNeedsDeep', [`${sobject}.${field}`]);
    }

    this.spinner.start(messages.getMessage(deep ? 'info.deepLoading' : 'info.loading'));

    let references: SourcedRef[] = [];

    try {
      const sourced: SourcedRef[] = [];

      // Dependency-API search is only available for custom fields
      if (isCustomField) {
        const fieldId = await resolveFieldId(inspectConn, sobject, field);
        const dependencyRefs = await queryInboundOnly(inspectConn, fieldId);
        sourced.push(...dependencyRefs.map((ref) => ({ ...ref, source: 'dependency' })));
      }

      if (deep) {
        const seen = new Set(sourced.map((ref) => canonicalRefKey(ref.type, ref.name)));
        const deepRefs = await deepSearchReferences(conn, sobject, field);

        for (const ref of deepRefs) {
          const key = canonicalRefKey(ref.type, ref.name);
          if (!seen.has(key)) {
            seen.add(key);
            sourced.push({ ...ref, source: 'deep' });
          }
        }
      }

      references = sourced.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    } finally {
      this.spinner.stop();
    }

    ux.log(`\n${messages.getMessage('info.header', [`${sobject}.${field}`, references.length.toString()])}\n`);

    if (references.length === 0) {
      ux.log(messages.getMessage('info.none'));
    } else {
      ux.table(references, refTableColumns);
    }

    if (!deep) {
      ux.log(messages.getMessage('info.caveat'));
    }

    return { sobject, field, references };
  }
}

const resolveFieldId = async (conn: ToolingInspectConnection, sobject: string, field: string): Promise<string> => {
  // MetadataComponentDependency keys custom fields off the Tooling API CustomField Id
  // (the 00N... id), not FieldDefinition.DurableId. The CustomField DeveloperName is the
  // field's API name without the trailing __c.
  const developerName = field.slice(0, -'__c'.length);

  const result = await conn.tooling.query<CustomFieldRecord>(
    `SELECT Id FROM CustomField WHERE EntityDefinition.QualifiedApiName = '${sobject}' AND DeveloperName = '${developerName}' LIMIT 1`
  );

  if (result.records.length === 0) {
    throw new Error(`Field '${sobject}.${field}' not found in this org.`);
  }

  return result.records[0].Id;
};

const refTableColumns: { [key: string]: { header: string; get: (row: SourcedRef) => string } } = {
  type: {
    header: 'Type',
    get: (row: SourcedRef): string => row.type,
  },
  name: {
    header: 'Name',
    get: (row: SourcedRef): string => row.name,
  },
  source: {
    header: 'Source',
    get: (row: SourcedRef): string => row.source,
  },
};
