import { SfCommand, Flags, Ux } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import {
  getExistingPackageDirectoryPaths,
  getMetadataPaths,
  retrieveSourceDirs,
  selectItems,
} from '../../shared/pull.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.pull');

export type RavenPullResult = {
  sourceDirs: string[];
  targetOrg?: string;
};

export default class RavenPull extends SfCommand<RavenPullResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.string({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: false,
    }),
    all: Flags.boolean({
      summary: messages.getMessage('flags.all.summary'),
      char: 'a',
      required: false,
      default: false,
    }),
  };

  public async run(): Promise<RavenPullResult> {
    const { flags } = await this.parse(RavenPull);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const sourceDirs = flags.all
      ? getExistingPackageDirectoryPaths(process.cwd())
      : await selectLocalMetadata(process.cwd());

    if (sourceDirs.length === 0) {
      ux.log(messages.getMessage('info.noSelection'));
      return {
        sourceDirs,
        targetOrg: flags['target-org'],
      };
    }

    ux.log(messages.getMessage('info.retrieveStarting', [sourceDirs.join(', ')]));

    const exitCode = await retrieveSourceDirs(sourceDirs, flags['target-org']);

    if (exitCode !== 0) {
      throw messages.createError('error.retrieveFailed', [exitCode.toString()]);
    }

    return {
      sourceDirs,
      targetOrg: flags['target-org'],
    };
  }
}

const selectLocalMetadata = async (projectRoot: string): Promise<string[]> => {
  const metadataPaths = getMetadataPaths(projectRoot);

  if (metadataPaths.length === 0) {
    throw messages.createError('error.noMetadataPaths');
  }

  return selectItems(metadataPaths);
};
