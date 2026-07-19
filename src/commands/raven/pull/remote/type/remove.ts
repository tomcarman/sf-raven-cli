import { Messages } from '@salesforce/core';
import { SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { getEffectiveRemoteMetadataTypes, removeRemoteMetadataTypes, selectItems } from '../../../../../shared/pull.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.pull.remote.type.remove');

export type RavenPullRemoteTypeRemoveResult = {
  metadataTypes: string[];
  removedMetadataTypes: string[];
};

export default class RavenPullRemoteTypeRemove extends SfCommand<RavenPullRemoteTypeRemoveResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public async run(): Promise<RavenPullRemoteTypeRemoveResult> {
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const existingMetadataTypes = await getEffectiveRemoteMetadataTypes(process.cwd());

    if (existingMetadataTypes.length === 0) {
      ux.log(messages.getMessage('info.noMetadataTypes'));

      return {
        metadataTypes: [],
        removedMetadataTypes: [],
      };
    }

    const removedMetadataTypes = await selectItems(existingMetadataTypes);

    if (removedMetadataTypes.length === 0) {
      ux.log(messages.getMessage('info.noSelection'));

      return {
        metadataTypes: existingMetadataTypes,
        removedMetadataTypes,
      };
    }

    const metadataTypes = await removeRemoteMetadataTypes(process.cwd(), removedMetadataTypes);

    ux.log(messages.getMessage('info.removedMetadataTypes', [removedMetadataTypes.join(', ')]));

    return {
      metadataTypes,
      removedMetadataTypes,
    };
  }
}
