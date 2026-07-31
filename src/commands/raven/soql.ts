import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { Args } from '@oclif/core';
import { Messages, type Connection, type Org } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import chalk from 'chalk';
import {
  DescribeCache,
  describeCacheDirectory,
  describeClients,
  type DescribeCapableConnection,
} from '../../shared/describeCache.js';
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
import {
  LineEditor,
  lineEditorEngages,
  type LineEditorCompleter,
  type LineEditorResult,
} from '../../shared/lineEditor.js';
import { completeSoql, outerSoqlFromObject } from '../../shared/soqlComplete.js';
import { highlightSoql } from '../../shared/soqlHighlight.js';
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
  ['\\refresh', 'Clear the cached describes used for tab completion and re-fetch them.'],
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
    const describes = new DescribeCache({
      directory: describeCacheDirectory(this.config.cacheDir, org.getOrgId(), connection.getApiVersion()),
      ...describeClients(connection as unknown as DescribeCapableConnection),
    });

    await new ReplSession(org, connection, ux, historyPath, describes).start();
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

type ReadlineWithHistory = Interface & { history: string[]; line?: string };

type ReplRead = LineEditorResult;

/** What the session needs from an input layer - the custom editor or readline. */
type ReplInput = {
  readLine(prompt: string): Promise<ReplRead>;
  setHistory(entries: readonly string[]): void;
  suspend(): void;
  restore(): void;
  close(): void;
};

/**
 * The plain readline input path: non-TTY stdin/stdout, dumb terminals, and
 * `RAVEN_SOQL_PLAIN=1`. Kept permanently as the fallback the custom editor
 * never replaces.
 */
class ReadlineReplInput implements ReplInput {
  private readonly rl: ReadlineWithHistory;
  private readonly pending: ReplRead[] = [];
  private waiting: ((read: ReplRead) => void) | undefined;
  private closed = false;

  public constructor(complete: LineEditorCompleter) {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: mainPrompt,
      historySize: soqlHistoryCap,
      completer: (lineToCursor: string): [string[], string] => complete(lineToCursor, this.rl.line ?? lineToCursor),
    }) as ReadlineWithHistory;

    this.rl.on('line', (text: string) => this.push({ kind: 'line', text }));
    this.rl.on('SIGINT', () => {
      this.rl.write(null, { ctrl: true, name: 'u' });
      process.stdout.write('\n');
      this.push({ kind: 'interrupt' });
    });
    this.rl.on('close', () => {
      this.closed = true;
      this.push({ kind: 'eof' });
    });
  }

  public async readLine(prompt: string): Promise<ReplRead> {
    if (this.closed && this.pending.length === 0) {
      return { kind: 'eof' };
    }

    if (!this.closed) {
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    }

    if (this.pending.length > 0) {
      return this.pending.shift() as ReplRead;
    }

    return new Promise((resolveRead) => {
      this.waiting = resolveRead;
    });
  }

  public setHistory(entries: readonly string[]): void {
    this.rl.history = [...entries].reverse();
  }

  public suspend(): void {
    this.rl.pause();
  }

  public restore(): void {
    this.rl.resume();
  }

  public close(): void {
    this.rl.close();
  }

  private push(read: ReplRead): void {
    const waiting = this.waiting;

    if (waiting != null) {
      this.waiting = undefined;
      waiting(read);
    } else {
      this.pending.push(read);
    }
  }
}

/**
 * The interactive loop. Everything behavioral (balance detection, meta
 * parsing, auto-limit, rendering) lives in the shared soql modules; this class
 * only wires an input layer, dispatches meta-commands, and owns session state.
 */
class ReplSession {
  private autoLimit = defaultSoqlAutoLimit;
  private toolingMode: SoqlToolingMode = 'auto';
  private format: RecordFormat = 'table';
  private buffer: string[] = [];
  private historyEntries: string[] = [];
  private lastExecution: SoqlExecution | undefined;
  private lastQuery: string | undefined;
  private input!: ReplInput;

  public constructor(
    private readonly org: Org,
    private readonly connection: Connection,
    private readonly ux: Ux,
    private readonly historyPath: string,
    private readonly describes: DescribeCache
  ) {}

  public async start(): Promise<void> {
    this.historyEntries = await loadSoqlHistory(this.historyPath);

    // Kick off the global describes now; the prompt appears immediately and
    // tab completion warms up when they land.
    void this.describes.warm();

    this.ux.log(messages.getMessage('info.welcome'));
    this.ux.log(
      chalk.dim(messages.getMessage('info.connected', [this.connection.instanceUrl, this.org.getUsername() ?? '']))
    );

    this.input = this.createInput();
    this.input.setHistory(this.historyEntries);

    for (;;) {
      // The REPL is inherently sequential: one line in, one result out.
      // eslint-disable-next-line no-await-in-loop
      const read = await this.input.readLine(this.buffer.length > 0 ? continuationPrompt : mainPrompt);

      if (read.kind === 'eof') {
        break;
      }

      if (read.kind === 'interrupt') {
        this.onInterrupt();
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const outcome = await this.handleLine(read.text);

      if (outcome === 'quit') {
        break;
      }
    }

    this.input.close();
    this.ux.log(messages.getMessage('info.exiting'));
  }

  /**
   * The custom line editor drives interactive terminals; anything it cannot
   * serve (non-TTY, dumb terminal, RAVEN_SOQL_PLAIN=1) gets plain readline.
   */
  private createInput(): ReplInput {
    const complete: LineEditorCompleter = (lineToCursor, fullLine) => this.complete(lineToCursor, fullLine);

    if (!lineEditorEngages(process.stdin, process.stdout, process.env)) {
      return new ReadlineReplInput(complete);
    }

    // Chalk already detects NO_COLOR and friends; without color support the
    // editor stays active but paints plain text.
    const highlight =
      chalk.level > 0
        ? (line: string): string =>
            highlightSoql(line, {
              openString: this.buffer.length > 0 && endsInsideSoqlString(this.buffer.join('\n')),
            })
        : undefined;

    return new LineEditor({ input: process.stdin, output: process.stdout, complete, highlight });
  }

  private onInterrupt(): void {
    if (this.buffer.length > 0) {
      this.buffer = [];
      this.ux.log(chalk.dim(messages.getMessage('info.abandoned')));
    } else {
      this.ux.log(chalk.dim(messages.getMessage('info.interruptHint')));
    }
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
      return 'continue';
    }

    this.buffer = [];

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
            this.describes.setToolingPreferred(command.mode === 'on');
          }

          this.ux.log(messages.getMessage('info.toolingState', [this.toolingMode]));
          break;
        case 'refresh':
          await this.describes.refresh();
          this.ux.log(messages.getMessage('info.refreshed'));
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

  /**
   * Tab completion. The input layer hands over the current line up to the
   * cursor; earlier lines of a multi-line query come from the continuation
   * buffer, and the full current line lets a FROM typed after the cursor count.
   */
  private complete(lineToCursor: string, fullLine: string): [string[], string] {
    return completeSoql(
      [...this.buffer, lineToCursor].join('\n'),
      [...this.buffer, fullLine].join('\n'),
      this.describes
    );
  }

  /**
   * In auto mode, an object the describes say is Tooling-only routes straight
   * to the Tooling API; everything else keeps the INVALID_TYPE retry.
   */
  private effectiveToolingMode(query: string): SoqlToolingMode {
    if (this.toolingMode !== 'auto') {
      return this.toolingMode;
    }

    const object = outerSoqlFromObject(query);

    return object != null && this.describes.isToolingOnly(object) === true ? 'on' : 'auto';
  }

  private async executeAndRender(query: string): Promise<void> {
    try {
      const execution = await executeSoql(this.connection as unknown as SoqlConnection, query, {
        autoLimit: this.autoLimit,
        toolingMode: this.effectiveToolingMode(query),
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

    this.input.suspend();

    const result = spawnSync(pager.command, pager.args, {
      input: `${text}\n`,
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    this.input.restore();

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

    this.input.suspend();

    const result = spawnSync(editor.command, [...editor.args, file], { stdio: 'inherit' });

    this.input.restore();

    if (result.error != null || (result.status ?? 0) !== 0) {
      throw messages.createError('error.editorFailed');
    }

    const edited = collapseSoqlQuery(await readFile(file, 'utf8'));

    if (edited === '' || edited === collapseSoqlQuery(initial)) {
      this.ux.log(messages.getMessage('info.editorUnchanged'));

      return;
    }

    this.buffer = [];
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

    this.input.setHistory(this.historyEntries);
  }
}
