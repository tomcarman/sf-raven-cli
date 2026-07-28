import { watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { ExecuteService } from '@salesforce/apex-node';
import { Messages, type Connection } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import chalk from 'chalk';
import {
  buildApexRunErrorEvent,
  buildApexRunEvent,
  buildApexRunResult,
  buildApexRunStatusEvent,
  renderApexRun,
  serializeApexRunEvent,
  DEFAULT_APEX_FILE,
  STARTER_APEX_BODY,
  type ApexRunResult,
  type ApexRunStreamEvent,
} from '../../../shared/apexRun.js';
import { createRunScheduler } from '../../../shared/runScheduler.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.apex.run');

const esc = String.fromCharCode(27);
const clearScreenSequence = `${esc}[2J${esc}[3J${esc}[H`;

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
    watch: Flags.boolean({
      summary: messages.getMessage('flags.watch.summary'),
      char: 'w',
      default: false,
    }),
    ndjson: Flags.boolean({
      summary: messages.getMessage('flags.ndjson.summary'),
      default: false,
    }),
  };

  public async run(): Promise<RavenApexRunResult> {
    const { flags, metadata } = await this.parse(RavenApexRun);
    const ndjson = flags.ndjson;

    if (flags.watch && this.jsonEnabled()) {
      throw messages.createError('error.watchWithJson');
    }

    if (ndjson && !flags.watch) {
      throw messages.createError('error.ndjsonRequiresWatch');
    }

    const ux = new Ux({ jsonEnabled: this.jsonEnabled() || ndjson });

    const org = flags['target-org'];

    if (org == null) {
      throw messages.createError('error.noTargetOrg');
    }

    const filePath = resolve(flags.file);
    const usingDefaultFile = metadata.flags['file']?.setFromDefault === true;

    // Reading up front both scaffolds the default file and fails fast on a bad
    // path, before watch mode commits to a long-running loop.
    const apexCode = await this.readApexFile(filePath, usingDefaultFile, ux);
    const connection = org.getConnection();
    const options: RunOptions = { raw: flags.raw, filter: flags.filter, ndjson };

    if (flags.watch) {
      await watchAndRun(connection, filePath, apexCode, options, ux);
    }

    const execution = await runOnce(connection, apexCode, options, ux);

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

type RunOptions = {
  raw: boolean;
  filter: string | undefined;
  ndjson: boolean;
};

type ApexExecution = {
  result: ApexRunResult;
  logs: string;
};

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';

const writeEventLine = (event: ApexRunStreamEvent): void => {
  process.stdout.write(`${serializeApexRunEvent(event)}\n`);
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

const runOnce = async (
  connection: Connection,
  apexCode: string,
  options: RunOptions,
  ux: Ux
): Promise<ApexExecution> => {
  ux.spinner.start(messages.getMessage('info.executing'));

  let execution: ApexExecution;

  try {
    execution = await executeApex(connection, apexCode, options.filter);
  } finally {
    ux.spinner.stop();
  }

  if (options.ndjson) {
    writeEventLine(buildApexRunEvent(execution.result));
    return execution;
  }

  for (const line of renderApexRun(execution.result, execution.logs, { raw: options.raw, filter: options.filter })) {
    ux.log(line);
  }

  return execution;
};

/**
 * Re-executes the file on every save until Ctrl+C. Watching the parent directory
 * rather than the file itself survives editors that save via atomic rename.
 */
const watchAndRun = async (
  connection: Connection,
  filePath: string,
  initialCode: string,
  options: RunOptions,
  ux: Ux
): Promise<never> => {
  const fileName = basename(filePath);
  const statusLine = messages.getMessage('info.watching', [filePath]);

  let code = initialCode;

  const runIteration = async (): Promise<void> => {
    if (options.ndjson) {
      writeEventLine(buildApexRunStatusEvent('run-start', filePath));
    } else {
      process.stdout.write(clearScreenSequence);
    }

    try {
      await runOnce(connection, code, options, ux);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (options.ndjson) {
        writeEventLine(buildApexRunErrorEvent(message));
      } else {
        ux.log(chalk.red(message));
      }
    }

    if (!options.ndjson) {
      ux.log(chalk.dim(statusLine));
    }
  };

  const scheduler = createRunScheduler(runIteration);

  const watcher = watch(dirname(filePath), (_eventType, changed) => {
    if (changed == null || basename(changed) !== fileName) {
      return;
    }

    void readFile(filePath, 'utf8')
      .then((contents) => {
        code = contents;
        scheduler.trigger();
      })
      .catch(() => {
        // The file is mid-save or gone; the next change event will pick it up.
      });
  });

  process.removeAllListeners('SIGINT');
  process.once('SIGINT', () => {
    scheduler.stop();
    watcher.close();
    ux.log(messages.getMessage('info.exiting'));
    process.exit(130);
  });

  if (options.ndjson) {
    writeEventLine(buildApexRunStatusEvent('watching', filePath));
  }

  scheduler.runNow();

  return new Promise<never>(() => {});
};
