import select from '@inquirer/select';
import { SfCommand, Flags, Ux } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import {
  getEffectiveRemoteMetadataTypes,
  getOrgOnlyMetadataNamesForType,
  isPromptForceCloseError,
  retrieveMetadataNames,
  selectItems,
} from '../../../shared/pull.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.pull.remote');

const orgOnlyPrefix = '☁  ';

type SelectPrompt = <Value>(config: {
  message: string;
  choices: readonly unknown[];
  pageSize?: number;
}) => Promise<Value>;

const selectPrompt = select as unknown as SelectPrompt;

export type RavenPullRemoteResult = {
  metadataType?: string;
  metadataNames: string[];
  targetOrg?: string;
};

export default class RavenPullRemote extends SfCommand<RavenPullRemoteResult> {
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

  public async run(): Promise<RavenPullRemoteResult> {
    const { flags } = await this.parse(RavenPullRemote);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const metadataTypes = await getEffectiveRemoteMetadataTypes(process.cwd());

    if (metadataTypes.length === 0) {
      throw messages.createError('error.noMetadataTypes');
    }

    const metadataType = await selectMetadataType(metadataTypes);

    if (metadataType == null) {
      ux.log(messages.getMessage('info.noTypeSelection'));
      return {
        metadataNames: [],
        targetOrg: flags['target-org'],
      };
    }

    ux.spinner.start(messages.getMessage('info.loadingRemoteMetadata'));

    let orgOnlyMetadata: string[];

    try {
      orgOnlyMetadata = await getOrgOnlyMetadataNamesForType(process.cwd(), metadataType, flags['target-org']);
    } finally {
      ux.spinner.stop();
    }

    if (orgOnlyMetadata.length === 0) {
      ux.log(messages.getMessage('info.noRemoteMetadata', [metadataType]));
      return {
        metadataType,
        metadataNames: [],
        targetOrg: flags['target-org'],
      };
    }

    const selectedDisplays = await selectItems(
      orgOnlyMetadata.map((metadataName) => `${orgOnlyPrefix}${metadataName}`)
    );
    const metadataNames = selectedDisplays.map((selectedDisplay) => selectedDisplay.replace(orgOnlyPrefix, ''));

    if (metadataNames.length === 0) {
      ux.log(messages.getMessage('info.noSelection'));
      return {
        metadataType,
        metadataNames,
        targetOrg: flags['target-org'],
      };
    }

    ux.log(messages.getMessage('info.retrieveStarting', [metadataNames.join(', ')]));

    const exitCode = await retrieveMetadataNames(metadataNames, flags['target-org']);

    if (exitCode !== 0) {
      throw messages.createError('error.retrieveFailed', [exitCode.toString()]);
    }

    return {
      metadataType,
      metadataNames,
      targetOrg: flags['target-org'],
    };
  }
}

const selectMetadataType = async (metadataTypes: string[]): Promise<string | undefined> => {
  try {
    return await selectPrompt<string>({
      message: messages.getMessage('prompt.selectMetadataType'),
      choices: metadataTypes.map((metadataType) => ({
        name: metadataType,
        value: metadataType,
      })),
      pageSize: 15,
    });
  } catch (error) {
    if (isPromptForceCloseError(error)) {
      return undefined;
    }

    throw error;
  }
};
