import { Messages } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import {
  addRemoteMetadataTypes,
  getEffectiveRemoteMetadataTypes,
  listOrgMetadataTypes,
  selectItems,
} from '../../../../../shared/pull.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.pull.remote.type.add');

export type RavenPullRemoteTypeAddResult = {
  addedMetadataTypes: string[];
  metadataTypes: string[];
  targetOrg?: string;
};

export default class RavenPullRemoteTypeAdd extends SfCommand<RavenPullRemoteTypeAddResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.string({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: false,
    }),
  };

  public async run(): Promise<RavenPullRemoteTypeAddResult> {
    const { flags } = await this.parse(RavenPullRemoteTypeAdd);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const existingMetadataTypes = await getEffectiveRemoteMetadataTypes(process.cwd());

    ux.spinner.start(messages.getMessage('info.loadingOrgMetadataTypes'));

    let orgMetadataTypes: string[];

    try {
      orgMetadataTypes = await listOrgMetadataTypes(flags['target-org']);
    } finally {
      ux.spinner.stop();
    }

    if (orgMetadataTypes.length === 0) {
      throw messages.createError('error.noOrgMetadataTypes');
    }

    const existingMetadataTypeSet = new Set(existingMetadataTypes);
    const availableMetadataTypes = orgMetadataTypes.filter(
      (metadataType) => !existingMetadataTypeSet.has(metadataType)
    );

    if (availableMetadataTypes.length === 0) {
      ux.log(messages.getMessage('info.noAvailableMetadataTypes'));

      return {
        addedMetadataTypes: [],
        metadataTypes: existingMetadataTypes,
        targetOrg: flags['target-org'],
      };
    }

    const addedMetadataTypes = await selectItems(availableMetadataTypes);

    if (addedMetadataTypes.length === 0) {
      ux.log(messages.getMessage('info.noSelection'));

      return {
        addedMetadataTypes,
        metadataTypes: existingMetadataTypes,
        targetOrg: flags['target-org'],
      };
    }

    const metadataTypes = await addRemoteMetadataTypes(process.cwd(), addedMetadataTypes);

    ux.log(messages.getMessage('info.addedMetadataTypes', [addedMetadataTypes.join(', ')]));

    return {
      addedMetadataTypes,
      metadataTypes,
      targetOrg: flags['target-org'],
    };
  }
}
