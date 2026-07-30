import { Messages } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import {
  dependencyComponentTypes,
  queryDependencies,
  resolveComponentId,
  type DependencyRef,
  type ToolingInspectConnection,
} from '../../../shared/inspect.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.inspect.dependencies');

export type RavenInspectDependenciesResult = {
  component: string;
  type: string;
  outbound: DependencyRef[];
  inbound: DependencyRef[];
};

export default class RavenInspectDependencies extends SfCommand<RavenInspectDependenciesResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: true,
    }),
    type: Flags.option({
      summary: messages.getMessage('flags.type.summary'),
      char: 't',
      required: true,
      options: dependencyComponentTypes,
    })(),
    name: Flags.string({
      summary: messages.getMessage('flags.name.summary'),
      char: 'n',
      required: true,
    }),
  };

  public async run(): Promise<RavenInspectDependenciesResult> {
    const { flags } = await this.parse(RavenInspectDependencies);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const org = flags['target-org'];
    const conn = org.getConnection() as unknown as ToolingInspectConnection;

    this.spinner.start(messages.getMessage('info.resolving'));

    let outbound: DependencyRef[] = [];
    let inbound: DependencyRef[] = [];

    try {
      const id = await resolveComponentId(conn, flags.type, flags.name);
      const dependencies = await queryDependencies(conn, id);
      outbound = dependencies.outbound;
      inbound = dependencies.inbound;
    } finally {
      this.spinner.stop();
    }

    ux.log(`\n${messages.getMessage('info.header', [flags.type, flags.name])}\n`);

    ux.log(messages.getMessage('info.dependsOn', [outbound.length.toString()]));

    if (outbound.length === 0) {
      ux.log(messages.getMessage('info.none'));
    } else {
      ux.table(outbound, refTableColumns);
    }

    ux.log('');
    ux.log(messages.getMessage('info.referencedBy', [inbound.length.toString()]));

    if (inbound.length === 0) {
      ux.log(messages.getMessage('info.none'));
    } else {
      ux.table(inbound, refTableColumns);
    }

    return { component: flags.name, type: flags.type, outbound, inbound };
  }
}

const refTableColumns: { [key: string]: { header: string; get: (row: DependencyRef) => string } } = {
  type: {
    header: 'Type',
    get: (row: DependencyRef): string => row.type,
  },
  name: {
    header: 'Name',
    get: (row: DependencyRef): string => row.name,
  },
};
