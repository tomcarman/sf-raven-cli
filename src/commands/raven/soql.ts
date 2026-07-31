import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { Args } from '@oclif/core';
import { Messages, type Connection, type Org } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import chalk from 'chalk';
import { buildRecordTarget, launchBrowser } from '../../shared/open.js';
import {
  buildFieldDefinitionQuery,
  fieldDefinitionColumns,
  type FieldDefinitionRecord,
} from '../../shared/objectFields.js';
import {
  formatRecordCsv,
  formatRecordOutput,
  formatRecordTable,
  queryRecords,
  recordFormats,
  type RecordFormat,
  type RecordQueryConnection,
} from '../../shared/recordQuery.js';
import { loadSoqlHistory, saveSoqlHistory, soqlHistoryPath } from '../../shared/soqlHistory.js';
import {
  appendSoqlHistory,
  buildSoqlFooter,
  collapseSoqlQuery,
  defaultSoqlAutoLimit,
  endsInsideSoqlString,
  formatSoqlExecutionError,
  isSoqlInputComplete,
  parseSoqlMetaLine,
  renderSoqlTable,
  soqlHistoryCap,
  splitCommandLine,
  type SoqlMetaCommand,
  type SoqlToolingMode,
} from '../../shared/soqlRepl.js';
import { executeSoql, type SoqlConnection, type SoqlExecution } from '../../shared/soqlSession.js';
import { renderTable } from '../../shared/table.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.soql');

const mainPrompt = 'soql> ';
const continuationPrompt = '  ...> ';

const helpLines: ReadonlyArray<[string, string]> = [
  ['\\help', 'Show this list.'],
  ['\\q', 'Exit (Ctrl+D works too).'],
  ['\\limit N', 'Set the auto-LIMIT for unbounded queries; 0 disables it.'],
  ['\\format <fmt>', `Set the output format: ${recordFormats.join(', ')}.`],
  ['\\csv <path>', 'Write the last result to a CSV file.'],
  ['\\fields <Object>', 'Show the field list of an object.'],
  ['\\open <row#>', "Open that row's record in the browser."],
  ['\\record <row#>', "Show every field of that row's record."],
  ['\\tooling [on|off|auto]', 'Force Tooling API routing, or show the current mode.'],
  ['\\e', 'Edit the last query in $EDITOR; it runs again if changed.'],
];

export type RavenSoqlResult = {
  query?: string;
  rowCount?: number;
  totalSize?: number;
  usedTooling?: boolean;
  durationMs?: number;
  records?: Array<Record<string, unknown>>;
};

export default class RavenSoql extends SfCommand<RavenSoqlResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly args = {
    query: Args.string({
      description: messages.getMessage('args.query.description'),
      required: false,
    }),
  };

  public static readonly flags = {
    'target-org': Flags.optionalOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
    }),
    format: Flags.option({
      summary: messages.getMessage('flags.format.summary'),
      char: 'F',
      options: recordFormats,
      default: 'table',
    })(),
  };

  public async run(): Promise<RavenSoqlResult> {
    const { args, flags, metadata } = await this.parse(RavenSoql);
    const org = flags['target-org'];

    if (org == null) {
      throw messages.createError('error.noTargetOrg');
    }

    const connection = org.getConnection();

    if (args.query != null) {
      return this.runOneShot(connection, args.query, flags.format);
    }

    const formatGiven = metadata.flags['format']?.setFromDefault !== true;

    if (this.jsonEnabled() || formatGiven) {
      throw messages.createError('error.replJson');
    }

    await this.runRepl(org, connection);

    return {};
  }

  private async runOneShot(connection: Connection, rawQuery: string, format: RecordFormat): Promise<RavenSoqlResult> {
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const query = collapseSoqlQuery(rawQuery);

    let execution: SoqlExecution;

    try {
      execution = await executeSoql(connection as unknown as SoqlConnection, query, {
        autoLimit: defaultSoqlAutoLimit,
        toolingMode: 'auto',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw messages.createError('error.queryFailed', [
        formatSoqlExecutionError(query, defaultSoqlAutoLimit, message).join('\n'),
      ]);
    }

    if (format === 'table') {
      for (const line of renderSoqlTable(execution)) {
        ux.log(line);
      }

      ux.log(chalk.dim(buildSoqlFooter(execution)));
    } else {
      ux.log(formatRecordOutput(execution, format, () => renderSoqlTable(execution).join('\n')));
    }

    return {
      query: execution.soql,
      rowCount: execution.rowCount,
      totalSize: execution.totalSize,
      usedTooling: execution.usedTooling,
      durationMs: execution.durationMs,
      records: execution.records,
    };
  }

  private async runRepl(org: Org, connection: Connection): Promise<void> {
    const ux = new Ux({ jsonEnabled: false });
    const historyPath = soqlHistoryPath(this.config.dataDir, org.getOrgId());

    await new ReplSession(org, connection, ux, historyPath).start();
  }
}

/** The record Id of the addressed row; throws when the row has no usable Id. */
const rowRecordId = (execution: SoqlExecution, row: number): string => {
  if (row > execution.records.length) {
    throw messages.createError('error.rowOutOfRange', [row, execution.records.length]);
  }

  const record = execution.records[row - 1];
  const idKey = Object.keys(record).find((key) => key.toLowerCase() === 'id');
  const id = idKey == null ? undefined : record[idKey];

  if (typeof id !== 'string' || id.length === 0) {
    throw messages.createError('error.noIdColumn');
  }

  return id;
};

type ReadlineWithHistory = Interface & { history: string[] };

/**
 * The interactive loop. Everything behavioral (balance detection, meta
 * parsing, auto-limit, rendering) lives in the shared soql modules; this class
 * only wires readline, dispatches meta-commands, and owns session state.
 */
class ReplSession {
  private autoLimit = defaultSoqlAutoLimit;
  private toolingMode: SoqlToolingMode = 'auto';
  private format: RecordFormat = 'table';
  private buffer: string[] = [];
  private historyEntries: string[] = [];
  private lastExecution: SoqlExecution | undefined;
  private lastQuery: string | undefined;
  private rl!: ReadlineWithHistory;

  public constructor(
    private readonly org: Org,
    private readonly connection: Connection,
    private readonly ux: Ux,
    private readonly historyPath: string
  ) {}

  public async start(): Promise<void> {
    this.historyEntries = await loadSoqlHistory(this.historyPath);

    this.ux.log(messages.getMessage('info.welcome'));
    this.ux.log(
      chalk.dim(messages.getMessage('info.connected', [this.connection.instanceUrl, this.org.getUsername() ?? '']))
    );

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: mainPrompt,
      historySize: soqlHistoryCap,
      history: [...this.historyEntries].reverse(),
    }) as ReadlineWithHistory;

    this.rl.on('SIGINT', () => this.onInterrupt());

    this.rl.prompt();

    for await (const line of this.rl) {
      const outcome = await this.handleLine(line);

      if (outcome === 'quit') {
        break;
      }

      this.rl.prompt();
    }

    this.rl.close();
    this.ux.log(messages.getMessage('info.exiting'));
  }

  private onInterrupt(): void {
    this.rl.write(null, { ctrl: true, name: 'u' });
    process.stdout.write('\n');

    if (this.buffer.length > 0) {
      this.buffer = [];
      this.rl.setPrompt(mainPrompt);
      this.ux.log(chalk.dim(messages.getMessage('info.abandoned')));
    } else {
      this.ux.log(chalk.dim(messages.getMessage('info.interruptHint')));
    }

    this.rl.prompt();
  }

  private async handleLine(line: string): Promise<'continue' | 'quit'> {
    const trimmed = line.trim();

    if (this.buffer.length === 0 && trimmed === '') {
      return 'continue';
    }

    // A `\` line is a meta-command even mid-continuation (so `\e` can rescue a
    // partial query) - except while inside an open string literal, where a
    // backslash is legitimate query text.
    if (trimmed.startsWith('\\') && (this.buffer.length === 0 || !endsInsideSoqlString(this.buffer.join('\n')))) {
      await this.recordHistory(trimmed);

      return this.dispatchMeta(parseSoqlMetaLine(trimmed));
    }

    this.buffer.push(line);
    const input = this.buffer.join('\n');

    if (!isSoqlInputComplete(input)) {
      this.rl.setPrompt(continuationPrompt);

      return 'continue';
    }

    this.buffer = [];
    this.rl.setPrompt(mainPrompt);

    const query = collapseSoqlQuery(input);

    await this.recordHistory(query);
    await this.executeAndRender(query);

    return 'continue';
  }

  private async dispatchMeta(command: SoqlMetaCommand): Promise<'continue' | 'quit'> {
    try {
      switch (command.type) {
        case 'quit':
          return 'quit';
        case 'help':
          this.showHelp();
          break;
        case 'invalid':
          this.ux.log(chalk.red(command.message));
          break;
        case 'limit':
          this.autoLimit = command.value;
          this.ux.log(
            command.value === 0
              ? messages.getMessage('info.limitDisabled')
              : messages.getMessage('info.limitSet', [command.value])
          );
          break;
        case 'format':
          this.format = command.value;
          this.ux.log(messages.getMessage('info.formatSet', [command.value]));
          break;
        case 'tooling':
          if (command.mode != null) {
            this.toolingMode = command.mode;
          }

          this.ux.log(messages.getMessage('info.toolingState', [this.toolingMode]));
          break;
        case 'csv':
          await this.writeCsv(command.path);
          break;
        case 'fields':
          await this.showFields(command.sobject);
          break;
        case 'open':
          await this.openRow(command.row);
          break;
        case 'record':
          await this.showRecord(command.row);
          break;
        case 'editor':
          await this.editAndRun();
          break;
      }
    } catch (error) {
      this.ux.log(chalk.red(error instanceof Error ? error.message : String(error)));
    }

    return 'continue';
  }

  private showHelp(): void {
    const width = Math.max(...helpLines.map(([name]) => name.length));

    for (const [name, explanation] of helpLines) {
      this.ux.log(`${chalk.cyan(name.padEnd(width))}  ${explanation}`);
    }
  }

  private async executeAndRender(query: string): Promise<void> {
    try {
      const execution = await executeSoql(this.connection as unknown as SoqlConnection, query, {
        autoLimit: this.autoLimit,
        toolingMode: this.toolingMode,
      });

      this.lastExecution = execution;
      this.lastQuery = query;

      const body = formatRecordOutput(execution, this.format, () =>
        renderSoqlTable(execution, { indexColumn: true }).join('\n')
      );

      this.pageOrPrint(`${body}\n${chalk.dim(buildSoqlFooter(execution))}`);
    } catch (error) {
      this.lastQuery = query;
      const message = error instanceof Error ? error.message : String(error);
      const [first, ...rest] = formatSoqlExecutionError(query, this.autoLimit, message);

      if (rest.length === 0) {
        this.ux.log(chalk.red(first));
      } else {
        this.ux.log(first);

        for (const line of rest) {
          this.ux.log(chalk.red(line));
        }
      }
    }
  }

  /** Output taller than the terminal goes through $PAGER; anything else prints. */
  private pageOrPrint(text: string): void {
    const rows = process.stdout.rows ?? 0;
    const lineCount = text.split('\n').length;

    if (!process.stdout.isTTY || rows === 0 || lineCount < rows) {
      this.ux.log(text);

      return;
    }

    const pager = splitCommandLine(process.env.PAGER) ?? { command: 'less', args: ['-SRFX'] };

    this.rl.pause();

    const result = spawnSync(pager.command, pager.args, {
      input: `${text}\n`,
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    this.rl.resume();

    if (result.error != null) {
      this.ux.log(text);
    }
  }

  private requireLastExecution(): SoqlExecution {
    if (this.lastExecution == null) {
      throw messages.createError('error.noResult');
    }

    return this.lastExecution;
  }

  private async writeCsv(path: string): Promise<void> {
    const execution = this.requireLastExecution();
    const target = resolve(path);

    await writeFile(target, `${formatRecordCsv(execution)}\n`, 'utf8');
    this.ux.log(messages.getMessage('info.csvWritten', [execution.rowCount, target]));
  }

  private async showFields(sobject: string): Promise<void> {
    const result = (await this.connection.query(buildFieldDefinitionQuery(sobject))) as unknown as {
      records: FieldDefinitionRecord[];
    };

    this.pageOrPrint(renderTable(result.records, fieldDefinitionColumns).join('\n'));
  }

  private async openRow(row: number): Promise<void> {
    const id = rowRecordId(this.requireLastExecution(), row);
    const url = await this.org.getFrontDoorUrl(buildRecordTarget(id).path);

    this.ux.log(messages.getMessage('info.opening', [id]));
    await launchBrowser(url);
  }

  private async showRecord(row: number): Promise<void> {
    const id = rowRecordId(this.requireLastExecution(), row);
    const result = await queryRecords(this.connection as unknown as RecordQueryConnection, { recordIds: id });

    this.pageOrPrint(formatRecordTable(result));
  }

  /** Edits the in-progress query when there is one, otherwise the last executed. */
  private async editAndRun(): Promise<void> {
    const initial = this.buffer.length > 0 ? this.buffer.join('\n') : this.lastQuery;

    if (initial == null) {
      throw messages.createError('error.noQueryToEdit');
    }

    const editor = splitCommandLine(process.env.EDITOR);

    if (editor == null) {
      throw messages.createError('error.noEditor');
    }

    const file = join(tmpdir(), `raven-soql-${process.pid}-${Date.now()}.soql`);

    await writeFile(file, `${initial}\n`, 'utf8');

    this.rl.pause();

    const result = spawnSync(editor.command, [...editor.args, file], { stdio: 'inherit' });

    this.rl.resume();

    if (result.error != null || (result.status ?? 0) !== 0) {
      throw messages.createError('error.editorFailed');
    }

    const edited = collapseSoqlQuery(await readFile(file, 'utf8'));

    if (edited === '' || edited === collapseSoqlQuery(initial)) {
      this.ux.log(messages.getMessage('info.editorUnchanged'));

      return;
    }

    this.buffer = [];
    this.rl.setPrompt(mainPrompt);
    await this.recordHistory(edited);
    await this.executeAndRender(edited);
  }

  /** Persists after every entry so a crash never loses the session's queries. */
  private async recordHistory(entry: string): Promise<void> {
    this.historyEntries = appendSoqlHistory(this.historyEntries, entry);

    try {
      await saveSoqlHistory(this.historyPath, this.historyEntries);
    } catch {
      // History is a convenience - never let it break the session.
    }

    this.rl.history = [...this.historyEntries].reverse();
  }
}
