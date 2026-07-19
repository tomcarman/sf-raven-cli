import { Messages } from '@salesforce/core';
import { SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { getEffectiveRemoteMetadataTypes } from '../../../../../shared/pull.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.pull.remote.type.list');

export type RavenPullRemoteTypeListResult = {
  metadataTypes: string[];
};

export default class RavenPullRemoteTypeList extends SfCommand<RavenPullRemoteTypeListResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public async run(): Promise<RavenPullRemoteTypeListResult> {
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const metadataTypes = await getEffectiveRemoteMetadataTypes(process.cwd());

    if (metadataTypes.length === 0) {
      ux.log(messages.getMessage('info.noMetadataTypes'));
    } else {
      ux.table(
        metadataTypes.map((metadataType) => ({ metadataType })),
        {
          metadataType: {
            header: messages.getMessage('table.metadataType.header'),
            get: (row) => row.metadataType,
          },
        }
      );
    }

    return {
      metadataTypes,
    };
  }
}
