import { Messages, SfProject, type Connection } from '@salesforce/core';
import { ensureArray } from '@salesforce/kit';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import {
  syncProfiles,
  type ProfileMetadata,
  type ProfileReader,
  type ProfileSyncResult,
  type SectionChanges,
  type SyncedProfile,
} from '../../../shared/profileSync.js';

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
    'dry-run': Flags.boolean({
      summary: messages.getMessage('flags.dry-run.summary'),
      default: false,
    }),
  };

  public async run(): Promise<RavenProfileSyncResult> {
    const { flags } = await this.parse(RavenProfileSync);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const projectRoot = process.cwd();
    const connection = flags['target-org'].getConnection(await getSourceApiVersion(projectRoot));
    const profileNames = flags.profile
      ?.map((profileName) => profileName.trim())
      .filter((profileName) => profileName.length > 0);

    if (profileNames != null && profileNames.length === 0) {
      throw messages.createError('error.noProfileNames');
    }

    const readProfiles = createProfileReader(connection);
    const dryRun = flags['dry-run'];
    const spinnerMessages = dryRun
      ? { all: 'info.checkingAll', named: 'info.checking' }
      : { all: 'info.syncingAll', named: 'info.syncing' };
    this.spinner.start(
      profileNames == null
        ? messages.getMessage(spinnerMessages.all)
        : messages.getMessage(spinnerMessages.named, [profileNames.join(', ')])
    );

    try {
      const result = await syncProfiles({ projectRoot, profileNames, readProfiles, dryRun });
      this.spinner.stop();

      displaySyncResult(ux, (message) => this.warn(message), result, dryRun);

      if (result.synced.length === 0 && result.skipped.length === 0 && result.failed.length === 0) {
        this.warn(messages.getMessage('warning.noProfiles'));
      }

      if (dryRun) {
        if (result.drifted) {
          const driftedCount = result.synced.filter((profile) => profile.changed).length;
          ux.log(messages.getMessage('info.driftDetected', [driftedCount]));
        }

        if (result.failed.length > 0) {
          ux.log(messages.getMessage('info.driftUnknown', [result.failed.length]));
        }

        if (result.drifted || result.failed.length > 0) {
          process.exitCode = 1;
        } else {
          ux.log(messages.getMessage('info.noDrift'));
        }
      }

      return result;
    } catch (error) {
      this.spinner.stop('failed');
      throw error;
    }
  }
}

export const createProfileReader =
  (connection: Connection): ProfileReader =>
  async (batchNames: string[]): Promise<ProfileMetadata[]> =>
    ensureArray(await connection.metadata.read('Profile', batchNames)) as unknown as ProfileMetadata[];

export const displaySyncResult = (
  ux: Ux,
  warn: (message: string) => void,
  result: ProfileSyncResult,
  dryRun: boolean
): void => {
  for (const profile of result.synced) {
    logSyncedProfile(ux, profile, dryRun);
  }

  for (const profile of result.skipped) {
    warn(messages.getMessage('warning.skipped', [profile.name]));
  }

  for (const profile of result.failed) {
    warn(messages.getMessage('warning.failed', [profile.name, profile.error]));
  }
};

const logSyncedProfile = (ux: Ux, profile: SyncedProfile, dryRun: boolean): void => {
  if (!profile.changed) {
    ux.log(messages.getMessage('info.unchanged', [profile.name]));
    return;
  }

  if (dryRun) {
    ux.log(messages.getMessage('info.wouldChange', [profile.name]));
  } else if (profile.adopted) {
    ux.log(messages.getMessage('info.adopted', [profile.name, profile.path]));
  } else {
    ux.log(messages.getMessage('info.synced', [profile.name, profile.path]));
  }

  if (profile.changes.length === 0) {
    ux.log(messages.getMessage('info.formattingOnly'));
    return;
  }

  for (const section of profile.changes) {
    ux.log(messages.getMessage('info.sectionChanges', [section.section, formatChangeCounts(section)]));
  }
};

const formatChangeCounts = (section: SectionChanges): string =>
  [
    section.added > 0 ? messages.getMessage('info.countAdded', [section.added]) : undefined,
    section.removed > 0 ? messages.getMessage('info.countRemoved', [section.removed]) : undefined,
    section.modified > 0 ? messages.getMessage('info.countModified', [section.modified]) : undefined,
  ]
    .filter((part): part is string => part != null)
    .join(', ');

export const getSourceApiVersion = async (projectRoot: string): Promise<string | undefined> => {
  const project = await SfProject.resolve(projectRoot);
  const sourceApiVersion = project.getSfProjectJson().get('sourceApiVersion');

  return typeof sourceApiVersion === 'string' ? sourceApiVersion : undefined;
};
