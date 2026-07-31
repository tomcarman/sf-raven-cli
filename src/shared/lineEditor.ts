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

/** The readline completer contract: candidates plus the fragment they replace. */
export type LineEditorCompleter = (lineToCursor: string, line: string) => [string[], string];

export type LineEditorOptions = {
  input: LineEditorInput;
  output: LineEditorOutput;
  /** Maps the plain line to its colored form; must preserve the visible width. */
  highlight?: (line: string) => string;
  complete?: LineEditorCompleter;
};

/**
 * The engagement gate: the custom editor drives interactive terminals only -
 * both streams must be TTYs, the terminal must not be dumb, and
 * RAVEN_SOQL_PLAIN=1 forces the plain fallback path.
 */
export const lineEditorEngages = (
  stdin: { isTTY?: boolean },
  stdout: { isTTY?: boolean },
  env: Record<string, string | undefined>
): boolean =>
  stdin.isTTY === true && stdout.isTTY === true && env.TERM !== 'dumb' && (env.RAVEN_SOQL_PLAIN ?? '') === '';

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

/** The completion menu shows at most this many rows; longer lists scroll. */
const menuMaxVisible = 10;

const inverseOn = '\u001b[7m';
const inverseOff = '\u001b[27m';

/**
 * The open completion menu. `candidates` is the list captured at the Tab
 * press; typing afterwards narrows the view live by re-matching the fragment,
 * which starts at `fragmentStart` and ends at the cursor.
 */
type MenuState = {
  candidates: string[];
  fragmentStart: number;
  selected: number;
  scrollTop: number;
};

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
  private readonly complete?: LineEditorCompleter;

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
  private menuState: MenuState | undefined;

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

  /** The open completion menu's filtered rows and selection, if one is open. */
  public get menu(): { rows: string[]; selected: number } | undefined {
    if (this.menuState == null) {
      return undefined;
    }

    return { rows: this.menuCandidates(this.menuState), selected: this.menuState.selected };
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
    this.menuState = undefined;
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
    this.menuState = undefined;

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
   *
   * An open completion menu paints below the line, one row per candidate;
   * writing those rows with \r\n scrolls the viewport when the line sits at
   * the bottom of the terminal, and the downward clear at the start of every
   * repaint is what tears the menu down again.
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

    const menuRows = this.menuState == null ? [] : this.renderMenuRows(this.menuState, cols);

    for (const row of menuRows) {
      out += `\r\n${row}`;
    }

    out += '\r';

    const up = endRow + menuRows.length - cursorRow;

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
    this.menuState = undefined;
    resolve?.(result);
  }

  private submit(): void {
    const text = this.currentLine;

    this.moveToEndRow();
    this.output.write('\r\n');
    this.finish({ kind: 'line', text });
  }

  /** Handles the bracketed-paste markers; a starting paste closes the menu. */
  private handlePasteMarker(key: LineEditorKey): boolean {
    if (key.name === 'paste-start') {
      this.menuState = undefined;
      this.pasting = true;

      return true;
    }

    if (key.name === 'paste-end') {
      this.pasting = false;

      return true;
    }

    return false;
  }

  private handleKey(str: string | undefined, key: LineEditorKey): void {
    if (this.handlePasteMarker(key)) {
      return;
    }

    if (this.sawReturnAt !== 0 && key.name !== 'enter') {
      this.sawReturnAt = 0;
    }

    if (this.menuState != null && this.handleMenuKey(this.menuState, str, key)) {
      return;
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
   * Tab: first insert the candidates' common prefix beyond the typed
   * fragment, re-casing the fragment to the canonical form on the way (`sel`
   * +Tab -> `SELECT`); a single candidate completes fully right there. When
   * multiple candidates remain the menu opens below the line. Case-divergent
   * candidates can make the common prefix shorter than the fragment - then
   * nothing inserts, but the menu still lists them.
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
    const start = this.currentCursor - fragment.length;

    if (prefix.toLowerCase().startsWith(fragment.toLowerCase()) && prefix !== fragment) {
      this.currentLine = this.currentLine.slice(0, start) + prefix + this.currentLine.slice(this.currentCursor);
      this.currentCursor = start + prefix.length;
    }

    if (candidates.length > 1) {
      this.menuState = { candidates, fragmentStart: start, selected: 0, scrollTop: 0 };
    }

    this.render();
  }

  /**
   * Keys the open menu consumes: Tab and Up/Down cycle the selection (Tab
   * accepts instead once filtering leaves a single row), Enter accepts, Esc
   * closes, and typing or Backspace re-filters the list against the fragment.
   * Anything else dismisses the menu and falls through to normal handling.
   */
  private handleMenuKey(menu: MenuState, str: string | undefined, key: LineEditorKey): boolean {
    if (key.name === 'escape') {
      this.menuState = undefined;
      this.render();

      return true;
    }

    if (key.ctrl === true || key.meta === true) {
      this.menuState = undefined;
      this.render();

      return false;
    }

    if (this.handleMenuSelectionKey(menu, key)) {
      return true;
    }

    if (key.name === 'backspace') {
      this.deleteLeft();
      this.refilterMenu();

      return true;
    }

    if (typeof str === 'string' && str.length > 0 && !lineEndingPattern.test(str)) {
      this.insert(sanitizeInsert(str));
      this.refilterMenu();

      return true;
    }

    this.menuState = undefined;
    this.render();

    return false;
  }

  /** Tab and Up/Down cycle, Enter accepts - Tab accepts too on a lone row. */
  private handleMenuSelectionKey(menu: MenuState, key: LineEditorKey): boolean {
    if (key.name === 'tab') {
      const filtered = this.menuCandidates(menu);

      if (filtered.length === 1) {
        this.acceptMenu(menu, filtered[0]);
      } else {
        this.moveMenuSelection(key.shift === true ? -1 : 1);
      }

      return true;
    }

    if (key.shift !== true && (key.name === 'up' || key.name === 'down')) {
      this.moveMenuSelection(key.name === 'down' ? 1 : -1);

      return true;
    }

    if (key.name === 'return' || key.name === 'enter') {
      const filtered = this.menuCandidates(menu);

      this.acceptMenu(menu, filtered[Math.min(menu.selected, filtered.length - 1)]);

      return true;
    }

    return false;
  }

  /** The captured candidates narrowed by what has been typed since Tab. */
  private menuCandidates(menu: MenuState): string[] {
    const fragment = this.currentLine.slice(menu.fragmentStart, this.currentCursor).toLowerCase();

    return menu.candidates.filter((candidate) => candidate.toLowerCase().startsWith(fragment));
  }

  /** Replaces the fragment with the accepted candidate and closes the menu. */
  private acceptMenu(menu: MenuState, candidate: string): void {
    this.menuState = undefined;
    this.currentLine =
      this.currentLine.slice(0, menu.fragmentStart) + candidate + this.currentLine.slice(this.currentCursor);
    this.currentCursor = menu.fragmentStart + candidate.length;
    this.render();
  }

  /** Cycles the selection with wrap-around, scrolling to keep it visible. */
  private moveMenuSelection(delta: number): void {
    const menu = this.menuState;

    if (menu == null) {
      return;
    }

    const count = this.menuCandidates(menu).length;

    menu.selected = (menu.selected + delta + count) % count;

    if (menu.selected < menu.scrollTop) {
      menu.scrollTop = menu.selected;
    } else if (menu.selected >= menu.scrollTop + menuMaxVisible) {
      menu.scrollTop = menu.selected - menuMaxVisible + 1;
    }

    this.render();
  }

  /**
   * After an edit while the menu is open: close it when the cursor left the
   * fragment or nothing matches any more, otherwise reset the selection to
   * the top of the narrowed list.
   */
  private refilterMenu(): void {
    const menu = this.menuState;

    if (menu == null) {
      return;
    }

    if (this.currentCursor < menu.fragmentStart || this.menuCandidates(menu).length === 0) {
      this.menuState = undefined;
    } else {
      menu.selected = 0;
      menu.scrollTop = 0;
    }

    this.render();
  }

  /** The visible slice of the menu: selected row inverse, width-clamped. */
  private renderMenuRows(menu: MenuState, cols: number): string[] {
    const filtered = this.menuCandidates(menu);
    const width = Math.min(Math.max(...filtered.map((candidate) => candidate.length), 1), cols - 1);

    return filtered.slice(menu.scrollTop, menu.scrollTop + menuMaxVisible).map((candidate, index) => {
      const text = candidate.slice(0, width).padEnd(width);

      return menu.scrollTop + index === menu.selected ? `${inverseOn}${text}${inverseOff}` : text;
    });
  }
}
