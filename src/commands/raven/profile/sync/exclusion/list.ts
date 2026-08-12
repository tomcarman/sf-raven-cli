import { Messages } from '@salesforce/core';
import { SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { getConfiguredExcludedSections } from '../../../../../shared/profileSyncConfig.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.profile.sync.exclusion.list');

export type RavenProfileSyncExclusionListResult = {
  excludedSections: string[];
};

export default class RavenProfileSyncExclusionList extends SfCommand<RavenProfileSyncExclusionListResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public async run(): Promise<RavenProfileSyncExclusionListResult> {
    await this.parse(RavenProfileSyncExclusionList);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const excludedSections = await getConfiguredExcludedSections(process.cwd());

    if (excludedSections.length === 0) {
      ux.log(messages.getMessage('info.noExclusions'));
    } else {
      for (const sectionName of excludedSections) {
        ux.log(sectionName);
      }
    }

    return { excludedSections };
  }
}
