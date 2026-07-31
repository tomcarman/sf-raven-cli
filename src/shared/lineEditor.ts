/**
 * A custom terminal line editor - the SOQL REPL's interactive input layer when
 * stdin/stdout are TTYs. Key decoding goes through the public
 * `readline.emitKeypressEvents` API and the keymap mirrors Node readline's
 * binding table (word jumps, kill keys, history navigation, bracketed paste),
 * so readline muscle memory keeps working. The editor repaints the whole
 * prompt-plus-line on every keypress - through an optional highlight callback
 * - and tracks the cursor across soft wraps, which is what makes live syntax
 * highlighting possible where readline allows none.
 *
 * Widths are counted in UTF-16 code units, which is exact for the ASCII that
 * SOQL is written in; astral or double-width characters may drift.
 */
import { emitKeypressEvents } from 'node:readline';

export type LineEditorResult = { kind: 'line'; text: string } | { kind: 'interrupt' } | { kind: 'eof' };

export type LineEditorKey = {
  sequence?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
};

export type LineEditorInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export type LineEditorOutput = {
  write: (data: string) => unknown;
  columns?: number;
  on?: (event: 'resize', listener: () => void) => unknown;
  removeListener?: (event: 'resize', listener: () => void) => unknown;
};

export type LineEditorOptions = {
  input: LineEditorInput;
  output: LineEditorOutput;
  /** Maps the plain line to its colored form; must preserve the visible width. */
  highlight?: (line: string) => string;
  /** The readline completer contract: candidates plus the fragment they replace. */
  complete?: (lineToCursor: string, line: string) => [string[], string];
};

/** Matches Node readline's crlfDelay default enough to swallow \r\n pairs. */
const crlfDelayMs = 200;

const enableBracketedPaste = '\u001b[?2004h';
const disableBracketedPaste = '\u001b[?2004l';

const lineEndingPattern = /\r\n|\n|\r/;

/** Word-boundary lengths use Node readline's exact regexes. */
const wordLeftLength = (leading: string): number => {
  const reversed = [...leading].reverse().join('');

  return /^\s*(?:[^\w\s]+|\w+)?/.exec(reversed)?.[0].length ?? 0;
};

const wordRightLength = (trailing: string): number => /^(?:\s+|[^\w\s]+|\w+)\s*/.exec(trailing)?.[0].length ?? 0;

const deleteWordRightLength = (trailing: string): number => /^(?:\s+|\W+|\w+)\s*/.exec(trailing)?.[0].length ?? 0;

/** Tabs become spaces; other control characters would corrupt cursor math. */
const sanitizeInsert = (data: string): string =>
  // eslint-disable-next-line no-control-regex
  data.replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

const commonPrefix = (candidates: readonly string[]): string => {
  let prefix = candidates[0];

  for (const candidate of candidates.slice(1)) {
    let length = 0;

    while (length < prefix.length && length < candidate.length && prefix[length] === candidate[length]) {
      length += 1;
    }

    prefix = prefix.slice(0, length);
  }

  return prefix;
};

type PendingKey = { str: string | undefined; key: LineEditorKey };

export class LineEditor {
  private readonly input: LineEditorInput;
  private readonly output: LineEditorOutput;
  private readonly highlight?: (line: string) => string;
  private readonly complete?: (lineToCursor: string, line: string) => [string[], string];

  private prompt = '';
  private currentLine = '';
  private currentCursor = 0;
  private prevCursorRow = 0;

  private active = false;
  private resolveRead: ((result: LineEditorResult) => void) | undefined;
  private readonly pendingKeys: PendingKey[] = [];

  /** Newest-first, mirroring Node readline's internal ordering. */
  private history: string[] = [];
  private historyIndex = -1;
  private searchPrefix: string | undefined;

  private pasting = false;
  private sawReturnAt = 0;

  public constructor(options: LineEditorOptions) {
    this.input = options.input;
    this.output = options.output;
    this.highlight = options.highlight;
    this.complete = options.complete;

    emitKeypressEvents(this.input as NodeJS.ReadableStream & NodeJS.EventEmitter);
    this.input.on('keypress', this.onKeypress);
    this.output.on?.('resize', this.onResize);
    this.input.setRawMode?.(true);
    this.input.resume?.();

    if (this.input.setRawMode != null) {
      this.output.write(enableBracketedPaste);
    }
  }

  public get line(): string {
    return this.currentLine;
  }

  public get cursor(): number {
    return this.currentCursor;
  }

  private get columns(): number {
    const columns = this.output.columns ?? 0;

    return columns > 0 ? columns : 80;
  }

  /** Oldest-first, as the session stores it; navigation walks from the end. */
  public setHistory(entries: readonly string[]): void {
    this.history = [...entries].reverse();
  }

  /**
   * Reads one line. Keypresses that arrived while no read was active (typed
   * ahead, or the tail of a paste that spanned a submit) are replayed first.
   */
  public async readLine(prompt: string): Promise<LineEditorResult> {
    this.prompt = prompt;
    this.currentLine = '';
    this.currentCursor = 0;
    this.prevCursorRow = 0;
    this.historyIndex = -1;
    this.searchPrefix = undefined;
    this.active = true;

    const promise = new Promise<LineEditorResult>((resolve) => {
      this.resolveRead = resolve;
    });

    this.render();

    while (this.pendingKeys.length > 0 && this.active) {
      const pending = this.pendingKeys.shift() as PendingKey;

      this.handleKey(pending.str, pending.key);
    }

    return promise;
  }

  /** Hands the terminal to an external command ($EDITOR, $PAGER). */
  public suspend(): void {
    if (this.input.setRawMode != null) {
      this.output.write(disableBracketedPaste);
    }

    this.input.setRawMode?.(false);
    this.input.pause?.();
  }

  /** Reclaims the terminal after `suspend` and repaints any active line. */
  public restore(): void {
    this.input.resume?.();
    this.input.setRawMode?.(true);

    if (this.input.setRawMode != null) {
      this.output.write(enableBracketedPaste);
    }

    if (this.active) {
      this.prevCursorRow = 0;
      this.render();
    }
  }

  public close(): void {
    this.input.removeListener('keypress', this.onKeypress);
    this.output.removeListener?.('resize', this.onResize);

    if (this.input.setRawMode != null) {
      this.output.write(disableBracketedPaste);
    }

    this.input.setRawMode?.(false);
    this.input.pause?.();
  }

  private readonly onKeypress = (str: string | undefined, key: LineEditorKey | undefined): void => {
    const resolved = key ?? {};

    if (!this.active) {
      this.pendingKeys.push({ str, key: resolved });

      return;
    }

    this.handleKey(str, resolved);
  };

  private readonly onResize = (): void => {
    if (this.active) {
      this.render();
    }
  };

  /**
   * Repaints prompt + line in place: cursor back to the render's first row,
   * clear downward, rewrite, then park the cursor at its logical position.
   * When the text ends exactly at the last column a space forces the pending
   * wrap to commit, keeping the math deterministic (readline's own trick).
   */
  private render(): void {
    const cols = this.columns;
    const visibleLength = this.prompt.length + this.currentLine.length;
    const endRow = Math.floor(visibleLength / cols);
    const cursorPos = this.prompt.length + this.currentCursor;
    const cursorRow = Math.floor(cursorPos / cols);
    const cursorCol = cursorPos % cols;

    let out = '';

    if (this.prevCursorRow > 0) {
      out += `\u001b[${this.prevCursorRow}A`;
    }

    out += '\r\u001b[J';
    out += this.prompt + (this.highlight == null ? this.currentLine : this.highlight(this.currentLine));

    if (visibleLength > 0 && visibleLength % cols === 0) {
      out += ' ';
    }

    out += '\r';

    const up = endRow - cursorRow;

    if (up > 0) {
      out += `\u001b[${up}A`;
    }

    if (cursorCol > 0) {
      out += `\u001b[${cursorCol}C`;
    }

    this.output.write(out);
    this.prevCursorRow = cursorRow;
  }

  /** Moves the terminal cursor to the render's last row, past any soft wraps. */
  private moveToEndRow(): void {
    const cols = this.columns;
    const endRow = Math.floor((this.prompt.length + this.currentLine.length) / cols);
    const down = endRow - this.prevCursorRow;

    if (down > 0) {
      this.output.write(`\u001b[${down}B`);
    }
  }

  private finish(result: LineEditorResult): void {
    const resolve = this.resolveRead;

    this.active = false;
    this.resolveRead = undefined;
    this.currentLine = '';
    this.currentCursor = 0;
    this.prevCursorRow = 0;
    resolve?.(result);
  }

  private submit(): void {
    const text = this.currentLine;

    this.moveToEndRow();
    this.output.write('\r\n');
    this.finish({ kind: 'line', text });
  }

  private handleKey(str: string | undefined, key: LineEditorKey): void {
    if (key.name === 'paste-start') {
      this.pasting = true;

      return;
    }

    if (key.name === 'paste-end') {
      this.pasting = false;

      return;
    }

    if (this.sawReturnAt !== 0 && key.name !== 'enter') {
      this.sawReturnAt = 0;
    }

    // Substring search: the text left of the cursor filters Up/Down history
    // navigation until any other key ends the search - as Node readline does.
    const plainUpDown =
      (key.name === 'up' || key.name === 'down') && key.ctrl !== true && key.meta !== true && key.shift !== true;

    if (plainUpDown) {
      this.searchPrefix ??= this.currentLine.slice(0, this.currentCursor);
    } else if (this.searchPrefix != null) {
      this.searchPrefix = undefined;

      if (this.historyIndex === this.history.length) {
        this.historyIndex = -1;
      }
    }

    if (this.pasting) {
      this.handlePasteKey(str, key);

      return;
    }

    if (key.name === 'escape') {
      return;
    }

    if (key.ctrl === true && key.shift === true) {
      this.handleCtrlShiftKey(key);
    } else if (key.ctrl === true) {
      this.handleCtrlKey(key);
    } else if (key.meta === true) {
      this.handleMetaKey(key);
    } else {
      this.handlePlainKey(str, key);
    }
  }

  /** Inside a paste only line endings act; everything else inserts as text. */
  private handlePasteKey(str: string | undefined, key: LineEditorKey): void {
    if (key.name === 'return' || key.name === 'enter') {
      this.handleLineEnding(key.name);
    } else if (typeof str === 'string' && str.length > 0) {
      this.insert(sanitizeInsert(str));
    }
  }

  /** A \n right after a \r is the tail of one CRLF, not a second Enter. */
  private handleLineEnding(name: 'return' | 'enter'): void {
    if (name === 'return') {
      this.sawReturnAt = Date.now();
      this.submit();

      return;
    }

    if (this.sawReturnAt === 0 || Date.now() - this.sawReturnAt > crlfDelayMs) {
      this.submit();
    }

    this.sawReturnAt = 0;
  }

  private handleCtrlShiftKey(key: LineEditorKey): void {
    switch (key.name) {
      case 'backspace':
        this.deleteLineLeft();
        break;
      case 'delete':
        this.deleteLineRight();
        break;
      default:
        break;
    }
  }

  private handleCtrlKey(key: LineEditorKey): void {
    switch (key.name) {
      case 'c':
        this.interrupt();
        break;
      case 'd':
        if (this.currentLine.length === 0) {
          this.output.write('\r\n');
          this.finish({ kind: 'eof' });
        } else if (this.currentCursor < this.currentLine.length) {
          this.deleteRight();
        }

        break;
      case 'h':
        this.deleteLeft();
        break;
      case 'u':
        this.deleteLineLeft();
        break;
      case 'k':
        this.deleteLineRight();
        break;
      case 'a':
        this.moveCursor(-Infinity);
        break;
      case 'e':
        this.moveCursor(Infinity);
        break;
      case 'b':
        this.moveCursor(-1);
        break;
      case 'f':
        this.moveCursor(1);
        break;
      case 'l':
        this.output.write('\u001b[1;1H\u001b[J');
        this.prevCursorRow = 0;
        this.render();
        break;
      case 'n':
        this.historyNext();
        break;
      case 'p':
        this.historyPrev();
        break;
      case 'w':
      case 'backspace':
        this.deleteWordLeft();
        break;
      case 'delete':
        this.deleteWordRight();
        break;
      case 'left':
        this.wordLeft();
        break;
      case 'right':
        this.wordRight();
        break;
      default:
        break;
    }
  }

  private handleMetaKey(key: LineEditorKey): void {
    switch (key.name) {
      case 'b':
        this.wordLeft();
        break;
      case 'f':
        this.wordRight();
        break;
      case 'd':
      case 'delete':
        this.deleteWordRight();
        break;
      case 'backspace':
        this.deleteWordLeft();
        break;
      case 'left':
        this.wordLeft();
        break;
      case 'right':
        this.wordRight();
        break;
      default:
        break;
    }
  }

  private handlePlainKey(str: string | undefined, key: LineEditorKey): void {
    switch (key.name) {
      case 'return':
      case 'enter':
        this.handleLineEnding(key.name);
        break;
      case 'backspace':
        this.deleteLeft();
        break;
      case 'delete':
        this.deleteRight();
        break;
      case 'left':
        this.moveCursor(-1);
        break;
      case 'right':
        this.moveCursor(1);
        break;
      case 'home':
        this.moveCursor(-Infinity);
        break;
      case 'end':
        this.moveCursor(Infinity);
        break;
      case 'up':
        this.historyPrev();
        break;
      case 'down':
        this.historyNext();
        break;
      case 'tab':
        this.completeWord();
        break;
      default:
        if (typeof str === 'string' && str.length > 0) {
          this.insertData(str);
        }

        break;
    }
  }

  /**
   * Inserts free-form data, treating embedded line endings as Enters - the
   * non-bracketed-paste path. A submit ends the active read, so anything after
   * the line ending queues for the next one.
   */
  private insertData(data: string): void {
    let rest = data;

    for (;;) {
      const match = lineEndingPattern.exec(rest);

      if (match == null) {
        if (rest.length > 0) {
          this.insert(sanitizeInsert(rest));
        }

        return;
      }

      this.insert(sanitizeInsert(rest.slice(0, match.index)));
      rest = rest.slice(match.index + match[0].length);
      this.submit();

      if (!this.active) {
        if (rest.length > 0) {
          this.pendingKeys.push({ str: rest, key: {} });
        }

        return;
      }
    }
  }

  private insert(text: string): void {
    if (text.length === 0) {
      return;
    }

    this.currentLine =
      this.currentLine.slice(0, this.currentCursor) + text + this.currentLine.slice(this.currentCursor);
    this.currentCursor += text.length;
    this.render();
  }

  private moveCursor(delta: number): void {
    const target = delta === -Infinity ? 0 : delta === Infinity ? this.currentLine.length : this.currentCursor + delta;

    this.currentCursor = Math.min(Math.max(target, 0), this.currentLine.length);
    this.render();
  }

  private interrupt(): void {
    this.currentLine = '';
    this.currentCursor = 0;
    this.render();
    this.output.write('\r\n');
    this.finish({ kind: 'interrupt' });
  }

  private deleteLeft(): void {
    if (this.currentCursor === 0) {
      return;
    }

    this.currentLine = this.currentLine.slice(0, this.currentCursor - 1) + this.currentLine.slice(this.currentCursor);
    this.currentCursor -= 1;
    this.render();
  }

  private deleteRight(): void {
    if (this.currentCursor >= this.currentLine.length) {
      return;
    }

    this.currentLine = this.currentLine.slice(0, this.currentCursor) + this.currentLine.slice(this.currentCursor + 1);
    this.render();
  }

  private deleteLineLeft(): void {
    this.currentLine = this.currentLine.slice(this.currentCursor);
    this.currentCursor = 0;
    this.render();
  }

  private deleteLineRight(): void {
    this.currentLine = this.currentLine.slice(0, this.currentCursor);
    this.render();
  }

  private wordLeft(): void {
    this.moveCursor(-wordLeftLength(this.currentLine.slice(0, this.currentCursor)));
  }

  private wordRight(): void {
    this.moveCursor(wordRightLength(this.currentLine.slice(this.currentCursor)));
  }

  private deleteWordLeft(): void {
    if (this.currentCursor === 0) {
      return;
    }

    const keep = this.currentCursor - wordLeftLength(this.currentLine.slice(0, this.currentCursor));

    this.currentLine = this.currentLine.slice(0, keep) + this.currentLine.slice(this.currentCursor);
    this.currentCursor = keep;
    this.render();
  }

  private deleteWordRight(): void {
    if (this.currentCursor >= this.currentLine.length) {
      return;
    }

    const trailing = this.currentLine.slice(this.currentCursor);

    this.currentLine = this.currentLine.slice(0, this.currentCursor) + trailing.slice(deleteWordRightLength(trailing));
    this.render();
  }

  /**
   * Node readline's history walk: newest-first array, index -1 is the live
   * line, entries matching the substring-search prefix (and differing from
   * the shown line) are eligible. Walking past the oldest end parks the index
   * there; walking back to -1 restores the search prefix as the line.
   */
  private historyPrev(): void {
    if (this.history.length === 0 || this.historyIndex === this.history.length) {
      return;
    }

    const search = this.searchPrefix ?? '';
    let index = this.historyIndex + 1;

    while (index < this.history.length && (!this.history[index].startsWith(search) || this.history[index] === this.currentLine)) {
      index += 1;
    }

    this.historyIndex = index;
    this.setLine(index === this.history.length ? search : this.history[index]);
  }

  private historyNext(): void {
    if (this.history.length === 0 || this.historyIndex <= -1) {
      return;
    }

    const search = this.searchPrefix ?? '';
    let index = this.historyIndex - 1;

    while (index >= 0 && (!this.history[index].startsWith(search) || this.history[index] === this.currentLine)) {
      index -= 1;
    }

    this.historyIndex = index;
    this.setLine(index === -1 ? search : this.history[index]);
  }

  private setLine(text: string): void {
    this.currentLine = text;
    this.currentCursor = text.length;
    this.render();
  }

  /**
   * Tab: insert the candidates' common prefix beyond the typed fragment,
   * re-casing the fragment to the canonical form on the way (`sel` +Tab ->
   * `SELECT`). The completion menu is a later ticket; nothing lists yet.
   */
  private completeWord(): void {
    if (this.complete == null) {
      return;
    }

    const [candidates, fragment] = this.complete(this.currentLine.slice(0, this.currentCursor), this.currentLine);

    if (candidates.length === 0) {
      return;
    }

    const prefix = commonPrefix(candidates);

    if (!prefix.toLowerCase().startsWith(fragment.toLowerCase()) || prefix === fragment) {
      return;
    }

    const start = this.currentCursor - fragment.length;

    this.currentLine = this.currentLine.slice(0, start) + prefix + this.currentLine.slice(this.currentCursor);
    this.currentCursor = start + prefix.length;
    this.render();
  }
}
