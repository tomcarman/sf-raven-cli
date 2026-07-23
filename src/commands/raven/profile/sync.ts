import { Messages, SfProject } from '@salesforce/core';
import { ensureArray } from '@salesforce/kit';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { syncProfiles, type ProfileMetadata, type ProfileSyncResult } from '../../../shared/profileSync.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.profile.sync');

export type RavenProfileSyncResult = ProfileSyncResult;

export default class RavenProfileSync extends SfCommand<RavenProfileSyncResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: true,
    }),
    profile: Flags.string({
      summary: messages.getMessage('flags.profile.summary'),
      char: 'p',
      multiple: true,
      delimiter: ',',
    }),
  };

  public async run(): Promise<RavenProfileSyncResult> {
    const { flags } = await this.parse(RavenProfileSync);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const projectRoot = process.cwd();
    const connection = flags['target-org'].getConnection(await getSourceApiVersion(projectRoot));
    const profileNames = flags.profile?.map((profileName) => profileName.trim()).filter((profileName) => profileName.length > 0);

    if (profileNames != null && profileNames.length === 0) {
      throw messages.createError('error.noProfileNames');
    }

    const readProfiles = async (batchNames: string[]): Promise<ProfileMetadata[]> =>
      ensureArray(await connection.metadata.read('Profile', batchNames)) as unknown as ProfileMetadata[];

    this.spinner.start(
      profileNames == null ? messages.getMessage('info.syncingAll') : messages.getMessage('info.syncing', [profileNames.join(', ')])
    );

    try {
      const result = await syncProfiles({ projectRoot, profileNames, readProfiles });
      this.spinner.stop();

      for (const profile of result.synced) {
        ux.log(messages.getMessage('info.synced', [profile.name, profile.path]));
      }

      for (const profile of result.skipped) {
        this.warn(messages.getMessage('warning.skipped', [profile.name]));
      }

      for (const profile of result.failed) {
        this.warn(messages.getMessage('warning.failed', [profile.name, profile.error]));
      }

      if (result.synced.length === 0 && result.skipped.length === 0 && result.failed.length === 0) {
        this.warn(messages.getMessage('warning.noProfiles'));
      }

      return result;
    } catch (error) {
      this.spinner.stop('failed');
      throw error;
    }
  }
}

const getSourceApiVersion = async (projectRoot: string): Promise<string | undefined> => {
  const project = await SfProject.resolve(projectRoot);
  const sourceApiVersion = project.getSfProjectJson().get('sourceApiVersion');

  return typeof sourceApiVersion === 'string' ? sourceApiVersion : undefined;
};
