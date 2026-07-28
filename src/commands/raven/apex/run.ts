import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ExecuteService } from '@salesforce/apex-node';
import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import {
  buildApexRunResult,
  renderApexRun,
  DEFAULT_APEX_FILE,
  STARTER_APEX_BODY,
  type ApexRunResult,
} from '../../../shared/apexRun.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.apex.run');

export type RavenApexRunResult = ApexRunResult;

export default class RavenApexRun extends SfCommand<RavenApexRunResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.optionalOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
    }),
    file: Flags.file({
      summary: messages.getMessage('flags.file.summary'),
      char: 'f',
      default: DEFAULT_APEX_FILE,
    }),
    filter: Flags.string({
      summary: messages.getMessage('flags.filter.summary'),
    }),
    raw: Flags.boolean({
      summary: messages.getMessage('flags.raw.summary'),
      default: false,
    }),
  };

  public async run(): Promise<RavenApexRunResult> {
    const { flags, metadata } = await this.parse(RavenApexRun);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });

    const org = flags['target-org'];

    if (org == null) {
      throw messages.createError('error.noTargetOrg');
    }

    const filePath = resolve(flags.file);
    const usingDefaultFile = metadata.flags['file']?.setFromDefault === true;

    const apexCode = await this.readApexFile(filePath, usingDefaultFile, ux);

    ux.spinner.start(messages.getMessage('info.executing'));

    let execution: ApexExecution;

    try {
      execution = await executeApex(org.getConnection(), apexCode, flags.filter);
    } finally {
      ux.spinner.stop();
    }

    for (const line of renderApexRun(execution.result, execution.logs, { raw: flags.raw, filter: flags.filter })) {
      ux.log(line);
    }

    if (!execution.result.success) {
      process.exitCode = 1;
    }

    return execution.result;
  }

  /**
   * Reads the apex file, offering to scaffold it when the user is on the default
   * path and has not created a scratch file yet.
   */
  private async readApexFile(filePath: string, usingDefaultFile: boolean, ux: Ux): Promise<string> {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      if (!usingDefaultFile) {
        throw messages.createError('error.fileNotFound', [filePath]);
      }

      const create = await this.confirm({
        message: messages.getMessage('prompt.createFile', [filePath]),
        defaultAnswer: true,
      });

      if (!create) {
        throw messages.createError('error.fileNotFound', [filePath]);
      }

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, STARTER_APEX_BODY, 'utf8');
      ux.log(messages.getMessage('info.fileCreated', [filePath]));

      return STARTER_APEX_BODY;
    }
  }
}

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';

type ApexExecution = {
  result: ApexRunResult;
  logs: string;
};

const executeApex = async (
  connection: Connection,
  apexCode: string,
  filter: string | undefined
): Promise<ApexExecution> => {
  const service = new ExecuteService(connection);
  const startedAt = Date.now();
  const response = await service.executeAnonymous({ apexCode });
  const duration = Date.now() - startedAt;

  return { result: buildApexRunResult(response, duration, filter), logs: response.logs ?? '' };
};
