import { SfCommand, Flags, Ux } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import {
  getComponentInventory,
  getOrgTypeInventory,
  getTypeInventory,
  type PullListComponentsResult,
  type PullListTypesResult,
} from '../../../shared/pull.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.pull.list');

export type RavenPullListResult = PullListTypesResult | PullListComponentsResult;

export default class RavenPullList extends SfCommand<RavenPullListResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.string({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: false,
    }),
    'all-types': Flags.boolean({
      summary: messages.getMessage('flags.all-types.summary'),
      required: false,
      default: false,
      exclusive: ['metadata-type'],
    }),
    'metadata-type': Flags.string({
      summary: messages.getMessage('flags.metadata-type.summary'),
      char: 'm',
      required: false,
      exclusive: ['all-types'],
    }),
  };

  public async run(): Promise<RavenPullListResult> {
    const { flags } = await this.parse(RavenPullList);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    if (flags['metadata-type'] != null) {
      const result = await getComponentInventory(process.cwd(), flags['metadata-type'], flags['target-org']);
      displayComponents(ux, result);
      return result;
    }

    const result = flags['all-types'] ? await getOrgTypeInventory(flags['target-org']) : await getTypeInventory(process.cwd());
    displayTypes(ux, result);
    return result;
  }
}

const displayTypes = (ux: Ux, result: PullListTypesResult): void => {
  ux.log(messages.getMessage('info.source', [result.source]));

  if (result.types.length === 0) {
    ux.log(messages.getMessage('info.noTypes'));
    return;
  }

  ux.table(result.types, {
    name: {
      header: messages.getMessage('table.name.header'),
      get: (row) => row.name,
    },
    ...(result.source === 'org'
      ? {}
      : {
          localCount: {
            header: messages.getMessage('table.localCount.header'),
            get: (row) => String(row.localCount ?? 0),
          },
        }),
  });
};

const displayComponents = (ux: Ux, result: PullListComponentsResult): void => {
  if (result.components.length === 0) {
    ux.log(messages.getMessage('info.noComponents', [result.metadataType]));
    return;
  }

  ux.table(result.components, {
    name: {
      header: messages.getMessage('table.name.header'),
      get: (row) => row.name,
    },
    status: {
      header: messages.getMessage('table.status.header'),
      get: (row) => row.status,
    },
  });
};
