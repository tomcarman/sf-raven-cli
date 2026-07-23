import { Messages } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { syncProfiles, type ProfileSyncResult } from '../../../../shared/profileSync.js';
import { getComponentInventory, selectItems } from '../../../../shared/pull.js';
import { createProfileReader, displaySyncResult, getSourceApiVersion } from '../sync.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.profile.sync.select');

export type RavenProfileSyncSelectResult = ProfileSyncResult;

export default class RavenProfileSyncSelect extends SfCommand<RavenProfileSyncSelectResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: true,
    }),
  };

  public async run(): Promise<RavenProfileSyncSelectResult> {
    const { flags } = await this.parse(RavenProfileSyncSelect);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const projectRoot = process.cwd();
    const targetOrg = flags['target-org'];
    const emptyResult: ProfileSyncResult = { synced: [], skipped: [], failed: [], dryRun: false, drifted: false };

    this.spinner.start(messages.getMessage('info.listing'));
    const inventory = await getComponentInventory(projectRoot, 'Profile', targetOrg.getUsername());
    this.spinner.stop();

    if (inventory.components.length === 0) {
      this.warn(messages.getMessage('warning.noProfiles'));
      return emptyResult;
    }

    const profileNames = await selectProfiles(inventory.components);

    if (profileNames.length === 0) {
      ux.log(messages.getMessage('info.noSelection'));
      return emptyResult;
    }

    const connection = targetOrg.getConnection(await getSourceApiVersion(projectRoot));
    this.spinner.start(messages.getMessage('info.syncing', [profileNames.join(', ')]));

    try {
      const result = await syncProfiles({
        projectRoot,
        profileNames,
        readProfiles: createProfileReader(connection),
        adoptUntracked: true,
      });
      this.spinner.stop();

      displaySyncResult(ux, (message) => this.warn(message), result, false);

      return result;
    } catch (error) {
      this.spinner.stop('failed');
      throw error;
    }
  }
}

const selectProfiles = async (components: Array<{ name: string; status: string }>): Promise<string[]> => {
  const namesByItem = new Map(components.map((component) => [`${component.name} (${component.status})`, component.name]));
  const selectedItems = await selectItems(Array.from(namesByItem.keys()));

  return selectedItems.map((item) => namesByItem.get(item)).filter((name): name is string => name != null);
};
