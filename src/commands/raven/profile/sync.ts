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
      required: true,
    }),
  };

  public async run(): Promise<RavenProfileSyncResult> {
    const { flags } = await this.parse(RavenProfileSync);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const projectRoot = process.cwd();
    const connection = flags['target-org'].getConnection(await getSourceApiVersion(projectRoot));

    const readProfiles = async (profileNames: string[]): Promise<ProfileMetadata[]> =>
      ensureArray(await connection.metadata.read('Profile', profileNames)) as unknown as ProfileMetadata[];

    this.spinner.start(messages.getMessage('info.syncing', [flags.profile]));

    try {
      const result = await syncProfiles({ projectRoot, profileNames: [flags.profile], readProfiles });
      this.spinner.stop();

      for (const profile of result.synced) {
        ux.log(messages.getMessage('info.synced', [profile.name, profile.path]));
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
