import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LineEditor, lineEditorEngages, type LineEditorInput, type LineEditorResult } from '../../src/shared/lineEditor.js';

/** A fake stdout: captures writes, reports a width, can emit 'resize'. */
class FakeOutput extends EventEmitter {
  public columns = 80;
  public chunks: string[] = [];

  public write(data: string): boolean {
    this.chunks.push(data);

    return true;
  }

  public get lastChunk(): string {
    return this.chunks[this.chunks.length - 1] ?? '';
  }

  public get text(): string {
    return this.chunks.join('');
  }
}

type Harness = {
  input: PassThrough;
  output: FakeOutput;
  editor: LineEditor;
  press: (data: string) => Promise<void>;
};

const esc = '\u001b';

/** Raw byte sequences a terminal would send for each key. */
const keys = {
  left: `${esc}[D`,
  right: `${esc}[C`,
  home: `${esc}[H`,
  end: `${esc}[F`,
  up: `${esc}[A`,
  down: `${esc}[B`,
  delete: `${esc}[3~`,
  backspace: '\u007f',
  ctrlA: '\u0001',
  ctrlB: '\u0002',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  ctrlE: '\u0005',
  ctrlF: '\u0006',
  ctrlH: '\u0008',
  ctrlK: '\u000b',
  ctrlN: '\u000e',
  ctrlP: '\u0010',
  ctrlU: '\u0015',
  ctrlW: '\u0017',
  ctrlG: '\u0007',
  ctrlR: '\u0012',
  ctrlLeft: `${esc}[1;5D`,
  ctrlRight: `${esc}[1;5C`,
  ctrlDelete: `${esc}[3;5~`,
  altB: `${esc}b`,
  altF: `${esc}f`,
  altD: `${esc}d`,
  altBackspace: `${esc}\u007f`,
  enter: '\r',
  tab: '\t',
  pasteStart: `${esc}[200~`,
  pasteEnd: `${esc}[201~`,
};

const harnesses: Harness[] = [];

const makeEditor = (options: Partial<ConstructorParameters<typeof LineEditor>[0]> = {}): Harness => {
  const input = new PassThrough();
  const output = new FakeOutput();
  const editor = new LineEditor({ input: input as unknown as LineEditorInput, output, ...options });
  const press = async (data: string): Promise<void> => {
    input.write(data);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  };
  const harness = { input, output, editor, press };

  harnesses.push(harness);

  return harness;
};

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.editor.close();
  }
});

describe('LineEditor', () => {
  describe('typing and submitting', () => {
    it('renders the prompt, echoes typed text, and submits on Enter', async () => {
      const { editor, output, press } = makeEditor();
      const read = editor.readLine('soql> ');

      await press('ab');
      assert.equal(editor.line, 'ab');
      assert.equal(editor.cursor, 2);
      assert.equal(output.lastChunk, `\r${esc}[Jsoql> ab\r${esc}[8C`);

      await press(keys.enter);
      assert.deepEqual(await read, { kind: 'line', text: 'ab' });
      assert.equal(output.lastChunk, '\r\n');
    });

    it('submits an empty line', async () => {
      const { editor, press } = makeEditor();
      const read = editor.readLine('soql> ');

      await press(keys.enter);
      assert.deepEqual(await read, { kind: 'line', text: '' });
    });

    it('inserts at the cursor, not the end', async () => {
      const { editor, press } = makeEditor();

      void editor.readLine('> ');
      await press('ac');
      await press(keys.left);
      await press('b');
      assert.equal(editor.line, 'abc');
      assert.equal(editor.cursor, 2);
    });

    it('replays keys typed while no read was active', async () => {
      const { editor, press } = makeEditor();

      await press('SELECT');
      const read = editor.readLine('> ');

      await press(keys.enter);
      assert.deepEqual(await read, { kind: 'line', text: 'SELECT' });
    });
  });

  describe('cursor movement', () => {
    it('moves with arrows, Home/End, and Ctrl+A/E/B/F', async () => {
      const { editor, press } = makeEditor();

      void editor.readLine('> ');
      await press('hello');
      await press(keys.home);
      assert.equal(editor.cursor, 0);
      await press(keys.end);
      assert.equal(editor.cursor, 5);
      await press(keys.ctrlA);
      assert.equal(editor.cursor, 0);
      await press(keys.ctrlE);
      assert.equal(editor.cursor, 5);
      await press(keys.left);
      await press(keys.ctrlB);
      assert.equal(editor.cursor, 3);
      await press(keys.ctrlF);
      await press(keys.right);
      assert.equal(editor.cursor, 5);
    });

    it('jumps words with Ctrl+arrows and Alt+B/F', async () => {
      const { editor, press } = makeEditor();

      void editor.readLine('> ');
      await press('SELECT Id FROM Account');
      await press(keys.ctrlLeft);
      assert.equal(editor.cursor, 15);
      await press(keys.altB);
      assert.equal(editor.cursor, 10);
      await press(keys.altF);
      assert.equal(editor.cursor, 15);
      await press(keys.ctrlRight);
      assert.equal(editor.cursor, 22);
    });
  });

  describe('deletion', () => {
    it('deletes left with Backspace and Ctrl+H, right with Delete', async () => {
      const { editor, press } = makeEditor();

      void editor.readLine('> ');
      await press('abcd');
      await press(keys.backspace);
      assert.equal(editor.line, 'abc');
      await press(keys.ctrlH);
      assert.equal(editor.line, 'ab');
      await press(keys.home);
      await press(keys.delete);
      assert.equal(editor.line, 'b');
      assert.equal(editor.cursor, 0);
    });

    it('deletes the word left with Ctrl+W and Alt+Backspace', async () => {
      const { editor, press } = makeEditor();

      void editor.readLine('> ');
      await press('SELECT Id FROM');
      await press(keys.ctrlW);
      assert.equal(editor.line, 'SELECT Id ');
      await press(keys.altBackspace);
      assert.equal(editor.line, 'SELECT ');
    });

    it('deletes the word right with Alt+D and Ctrl+Delete', async () => {
      const { editor, press } = makeEditor();

      void editor.readLine('> ');
      await press('SELECT Id FROM');
      await press(keys.home);
      await press(keys.altD);
      assert.equal(editor.line, 'Id FROM');
      await press(keys.ctrlDelete);
      assert.equal(editor.line, 'FROM');
    });

    it('kills to end with Ctrl+Shift+Delete', async () => {
      const { editor, press } = makeEditor();

      void editor.readLine('> ');
      await press('SELECT Id');
      await press(keys.left);
      await press(keys.left);
      await press(`${esc}[3;6~`);
      assert.equal(editor.line, 'SELECT ');
      assert.equal(editor.cursor, 7);
    });

    it('kills to start with Ctrl+U and to end with Ctrl+K', async () => {
      const { editor, press } = makeEditor();

      void editor.readLine('> ');
      await press('SELECT Id');
      await press(keys.left);
      await press(keys.left);
      await press(keys.ctrlK);
      assert.equal(editor.line, 'SELECT ');
      await press(keys.ctrlU);
      assert.equal(editor.line, '');
      assert.equal(editor.cursor, 0);
    });
  });

  describe('Ctrl+C and Ctrl+D', () => {
    it('resolves interrupt on Ctrl+C after clearing the line', async () => {
      const { editor, output, press } = makeEditor();
      const read = editor.readLine('soql> ');

      await press('SELECT');
      await press(keys.ctrlC);
      assert.deepEqual(await read, { kind: 'interrupt' });
      // The line clears before the newline so the prompt is left bare.
      assert.equal(output.chunks[output.chunks.length - 2], `\r${esc}[Jsoql> \r${esc}[6C`);
      assert.equal(output.lastChunk, '\r\n');
    });

    it('resolves eof on Ctrl+D only when the line is empty', async () => {
      const first = makeEditor();
      const read = first.editor.readLine('> ');

      await first.press(keys.ctrlD);
      assert.deepEqual(await read, { kind: 'eof' });

      const second = makeEditor();

      void second.editor.readLine('> ');
      await second.press('abc');
      await second.press(keys.left);
      await second.press(keys.left);
      await second.press(keys.ctrlD);
      assert.equal(second.editor.line, 'ac');
    });
  });

  describe('history', () => {
    it('walks entries with Up/Down, restoring the live line', async () => {
      const { editor, press } = makeEditor();

      editor.setHistory(['SELECT one', 'SELECT two']);
      void editor.readLine('> ');
      await press(keys.up);
      assert.equal(editor.line, 'SELECT two');
      await press(keys.up);
      assert.equal(editor.line, 'SELECT one');
      await press(keys.down);
      assert.equal(editor.line, 'SELECT two');
      await press(keys.down);
      assert.equal(editor.line, '');
    });

    it('walks entries with Ctrl+P/N', async () => {
      const { editor, press } = makeEditor();

      editor.setHistory(['SELECT one', 'SELECT two']);
      void editor.readLine('> ');
      await press(keys.ctrlP);
      assert.equal(editor.line, 'SELECT two');
      await press(keys.ctrlP);
      assert.equal(editor.line, 'SELECT one');
      await press(keys.ctrlN);
      assert.equal(editor.line, 'SELECT two');
      await press(keys.ctrlN);
      assert.equal(editor.line, '');
    });

    it('filters navigation by the text left of the cursor', async () => {
      const { editor, press } = makeEditor();

      editor.setHistory(['SELECT Id FROM Account', '\\help', 'SELECT Name FROM Contact']);
      void editor.readLine('> ');
      await press('SELECT');
      await press(keys.up);
      assert.equal(editor.line, 'SELECT Name FROM Contact');
      await press(keys.up);
      assert.equal(editor.line, 'SELECT Id FROM Account');
      await press(keys.up);
      assert.equal(editor.line, 'SELECT');
    });
  });

  describe('bracketed paste', () => {
    it('treats pasted newlines as Enters across reads', async () => {
      const { editor, press } = makeEditor();
      const first = editor.readLine('> ');

      await press(`${keys.pasteStart}SELECT Id\nFROM Account${keys.pasteEnd}`);
      assert.deepEqual(await first, { kind: 'line', text: 'SELECT Id' });

      const second = editor.readLine('> ');

      await press(keys.enter);
      assert.deepEqual(await second, { kind: 'line', text: 'FROM Account' });
    });

    it('submits a pasted CRLF once', async () => {
      const { editor, press } = makeEditor();
      const first = editor.readLine('> ');

      await press(`${keys.pasteStart}one\r\ntwo${keys.pasteEnd}`);
      assert.deepEqual(await first, { kind: 'line', text: 'one' });

      const second = editor.readLine('> ');

      await press(keys.enter);
      assert.deepEqual(await second, { kind: 'line', text: 'two' });
    });

    it('inserts pasted tabs as spaces without triggering completion', async () => {
      const { editor, press } = makeEditor({
        complete: (): [string[], string] => [['NEVER'], ''],
      });

      void editor.readLine('> ');
      await press(`${keys.pasteStart}a${keys.tab}b${keys.pasteEnd}`);
      assert.equal(editor.line, 'a b');
    });
  });

  describe('rendering', () => {
    it('positions the cursor across soft wraps', async () => {
      const { editor, output, press } = makeEditor();

      output.columns = 10;
      void editor.readLine('soql> ');
      await press('abcdefgh');
      // 14 visible chars on a 10-column terminal: cursor parks at row 1 col 4.
      assert.equal(output.lastChunk, `${esc}[1A\r${esc}[Jsoql> abcdefgh\r${esc}[4C`);
    });

    it('commits the pending wrap when the text ends exactly at the last column', async () => {
      const { editor, output, press } = makeEditor();

      output.columns = 10;
      void editor.readLine('soql> ');
      await press('abcd');
      // The trailing space commits the wrap; \r then parks at row 1 col 0.
      assert.equal(output.lastChunk, `\r${esc}[Jsoql> abcd \r`);
    });

    it('repaints through the highlight callback', async () => {
      const { editor, output, press } = makeEditor({
        highlight: (line: string): string => `<${line}>`,
      });

      void editor.readLine('> ');
      await press('a');
      assert.equal(output.lastChunk, `\r${esc}[J> <a>\r${esc}[3C`);
    });

    it('clears the screen and repaints on Ctrl+L', async () => {
      const { editor, output, press } = makeEditor();

      void editor.readLine('> ');
      await press('ab');
      await press('\u000c');
      assert.equal(output.chunks[output.chunks.length - 2], `${esc}[1;1H${esc}[J`);
      assert.equal(output.lastChunk, `\r${esc}[J> ab\r${esc}[4C`);
      assert.equal(editor.line, 'ab');
    });

    it('repaints on terminal resize', async () => {
      const { editor, output, press } = makeEditor();

      void editor.readLine('> ');
      await press('ab');
      output.columns = 20;
      output.emit('resize');
      assert.equal(output.lastChunk, `\r${esc}[J> ab\r${esc}[4C`);
      assert.equal(editor.line, 'ab');
    });
  });

  describe('tab completion', () => {
    it('inserts the common prefix beyond the fragment', async () => {
      const { editor, press } = makeEditor({
        complete: (): [string[], string] => [['Name', 'NumberOfEmployees'], 'N'],
      });

      void editor.readLine('> ');
      await press('N');
      await press(keys.tab);
      assert.equal(editor.line, 'N');

      const single = makeEditor({
        complete: (): [string[], string] => [['SELECT'], 'sel'],
      });

      void single.editor.readLine('> ');
      await single.press('sel');
      await single.press(keys.tab);
      assert.equal(single.editor.line, 'SELECT');
      assert.equal(single.editor.cursor, 6);
    });

    it('does nothing without candidates', async () => {
      const { editor, press } = makeEditor({
        complete: (): [string[], string] => [[], 'zz'],
      });

      void editor.readLine('> ');
      await press('zz');
      await press(keys.tab);
      assert.equal(editor.line, 'zz');
    });

    it('passes the line to the cursor and the full line to the completer', async () => {
      const calls: Array<[string, string]> = [];
      const { editor, press } = makeEditor({
        complete: (lineToCursor: string, line: string): [string[], string] => {
          calls.push([lineToCursor, line]);

          return [[], ''];
        },
      });

      void editor.readLine('> ');
      await press('SELECT Id');
      await press(keys.home);
      await press(keys.tab);
      assert.deepEqual(calls, [['', 'SELECT Id']]);
    });
  });

  describe('completion menu', () => {
    const inverse = (text: string): string => `${esc}[7m${text}${esc}[27m`;
    const shiftTab = `${esc}[Z`;

    /** A completer shaped like completeSoql: case-insensitive prefix matches. */
    const fragmentCompleter =
      (candidates: string[]) =>
      (before: string): [string[], string] => {
        const fragment = /[A-Za-z0-9_]*$/.exec(before)?.[0] ?? '';

        return [candidates.filter((candidate) => candidate.toLowerCase().startsWith(fragment.toLowerCase())), fragment];
      };

    const pressEscape = async (harness: Harness): Promise<void> => {
      harness.input.emit('keypress', esc, { name: 'escape', sequence: esc });
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    };

    it('completes the common prefix, then opens the menu below the line', async () => {
      const { editor, output, press } = makeEditor({ complete: fragmentCompleter(['Name', 'NumberOfEmployees']) });

      void editor.readLine('> ');
      await press('n');
      await press(keys.tab);
      assert.equal(editor.line, 'N');
      assert.deepEqual(editor.menu, { rows: ['Name', 'NumberOfEmployees'], selected: 0 });
      // Rows paint below the input line; the cursor climbs back to its spot.
      assert.equal(
        output.lastChunk,
        `\r${esc}[J> N\r\n${inverse('Name'.padEnd(17))}\r\nNumberOfEmployees\r${esc}[2A${esc}[3C`
      );
    });

    it('inserts a single candidate directly and never opens the menu', async () => {
      const { editor, press } = makeEditor({ complete: fragmentCompleter(['SELECT']) });

      void editor.readLine('> ');
      await press('sel');
      await press(keys.tab);
      assert.equal(editor.line, 'SELECT');
      assert.equal(editor.menu, undefined);
    });

    it('opens the menu without inline completion when candidate casing diverges', async () => {
      const { editor, press } = makeEditor({ complete: fragmentCompleter(['Name', 'NAICSCode']) });

      void editor.readLine('> ');
      await press('na');
      await press(keys.tab);
      assert.equal(editor.line, 'na');
      assert.deepEqual(editor.menu, { rows: ['Name', 'NAICSCode'], selected: 0 });
    });

    it('cycles the selection with Tab, Shift+Tab, Up, and Down', async () => {
      const { editor, press } = makeEditor({ complete: fragmentCompleter(['One', 'Two', 'Three']) });

      void editor.readLine('> ');
      await press(keys.tab);
      assert.equal(editor.menu?.selected, 0);
      await press(keys.tab);
      assert.equal(editor.menu?.selected, 1);
      await press(keys.tab);
      assert.equal(editor.menu?.selected, 2);
      await press(keys.tab);
      assert.equal(editor.menu?.selected, 0);
      await press(shiftTab);
      assert.equal(editor.menu?.selected, 2);
      await press(keys.up);
      assert.equal(editor.menu?.selected, 1);
      await press(keys.down);
      assert.equal(editor.menu?.selected, 2);
    });

    it('accepts the selection with Enter without submitting the read', async () => {
      const { editor, press } = makeEditor({ complete: fragmentCompleter(['Name', 'NumberOfEmployees']) });
      const read = editor.readLine('> ');

      await press('n');
      await press(keys.tab);
      await press(keys.down);
      await press(keys.enter);
      assert.equal(editor.line, 'NumberOfEmployees');
      assert.equal(editor.cursor, 17);
      assert.equal(editor.menu, undefined);

      // The read is still pending; the next Enter submits the accepted line.
      await press(keys.enter);
      assert.deepEqual(await read, { kind: 'line', text: 'NumberOfEmployees' });
    });

    it('filters live as you type and accepts a lone survivor with Tab', async () => {
      const { editor, press } = makeEditor({ complete: fragmentCompleter(['Name', 'Phone', 'NumberOfEmployees']) });

      void editor.readLine('> ');
      await press(keys.tab);
      assert.equal(editor.menu?.rows.length, 3);
      await press('p');
      assert.deepEqual(editor.menu, { rows: ['Phone'], selected: 0 });
      await press(keys.tab);
      assert.equal(editor.line, 'Phone');
      assert.equal(editor.menu, undefined);
    });

    it('closes on Esc leaving the line untouched', async () => {
      const harness = makeEditor({ complete: fragmentCompleter(['Name', 'NumberOfEmployees']) });

      void harness.editor.readLine('> ');
      await harness.press('n');
      await harness.press(keys.tab);
      await pressEscape(harness);
      assert.equal(harness.editor.menu, undefined);
      assert.equal(harness.editor.line, 'N');
      // The closing repaint carries no menu rows.
      assert.equal(harness.output.lastChunk, `\r${esc}[J> N\r${esc}[3C`);
    });

    it('closes when typing filters every candidate out', async () => {
      const { editor, press } = makeEditor({ complete: fragmentCompleter(['Name', 'NumberOfEmployees']) });

      void editor.readLine('> ');
      await press('n');
      await press(keys.tab);
      await press('z');
      assert.equal(editor.menu, undefined);
      assert.equal(editor.line, 'Nz');
    });

    it('refilters on Backspace and closes when the cursor leaves the fragment', async () => {
      const { editor, press } = makeEditor({ complete: fragmentCompleter(['Name', 'NumberOfEmployees']) });

      void editor.readLine('> ');
      await press('SELECT n');
      await press(keys.tab);
      assert.equal(editor.line, 'SELECT N');
      assert.equal(editor.menu?.rows.length, 2);
      await press(keys.backspace);
      assert.equal(editor.line, 'SELECT ');
      assert.equal(editor.menu?.rows.length, 2);
      await press(keys.backspace);
      assert.equal(editor.line, 'SELECT');
      assert.equal(editor.menu, undefined);
    });

    it('dismisses the menu on other keys, which still take effect', async () => {
      const { editor, press } = makeEditor({ complete: fragmentCompleter(['Name', 'NumberOfEmployees']) });

      void editor.readLine('> ');
      await press('n');
      await press(keys.tab);
      await press(keys.ctrlA);
      assert.equal(editor.menu, undefined);
      assert.equal(editor.line, 'N');
      assert.equal(editor.cursor, 0);
    });

    it('shows at most ten rows and scrolls to keep the selection visible', async () => {
      const candidates = Array.from({ length: 15 }, (_, index) => `Item${String(index + 1).padStart(2, '0')}`);
      const { editor, output, press } = makeEditor({ complete: fragmentCompleter(candidates) });

      void editor.readLine('> ');
      await press(keys.tab);
      assert.equal(editor.line, 'Item');
      assert.equal(output.lastChunk.split('\r\n').length - 1, 10);
      assert.equal(output.lastChunk.includes('Item10'), true);
      assert.equal(output.lastChunk.includes('Item11'), false);

      for (let presses = 0; presses < 10; presses++) {
        // eslint-disable-next-line no-await-in-loop
        await press(keys.tab);
      }

      assert.equal(editor.menu?.selected, 10);
      assert.equal(output.lastChunk.includes(inverse('Item11')), true);
      assert.equal(output.lastChunk.includes('Item01'), false);
      assert.equal(output.lastChunk.includes('Item02'), true);
    });

    it('truncates menu rows to the terminal width', async () => {
      const { editor, output, press } = makeEditor({ complete: fragmentCompleter(['Alpha_one_long', 'Alpha_two_long']) });

      output.columns = 10;
      void editor.readLine('> ');
      await press(keys.tab);
      assert.equal(editor.line, 'Alpha_');
      assert.equal(output.lastChunk.includes(`\r\n${inverse('Alpha_one')}`), true);
      assert.equal(output.lastChunk.includes('\r\nAlpha_two'), true);
    });

    it('closes when a paste begins', async () => {
      const { editor, press } = makeEditor({ complete: fragmentCompleter(['Name', 'NumberOfEmployees']) });

      void editor.readLine('> ');
      await press('n');
      await press(keys.tab);
      await press(`${keys.pasteStart}a${keys.pasteEnd}`);
      assert.equal(editor.menu, undefined);
      assert.equal(editor.line, 'Na');
    });

    it('closes on suspend so the $PAGER flow repaints cleanly', async () => {
      const { editor, press } = makeEditor({ complete: fragmentCompleter(['Name', 'NumberOfEmployees']) });

      void editor.readLine('> ');
      await press('n');
      await press(keys.tab);
      editor.suspend();
      assert.equal(editor.menu, undefined);
    });
  });

  describe('reverse history search', () => {
    const searchPrompt = (filter: string, match: string): string => `(reverse-i-search)\`${filter}': ${match}`;
    const failedPrompt = (filter: string, match: string): string => `(failed reverse-i-search)\`${filter}': ${match}`;

    const pressEscape = async (harness: Harness): Promise<void> => {
      harness.input.emit('keypress', esc, { name: 'escape', sequence: esc });
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    };

    const makeSearchEditor = (): Harness & { read: Promise<LineEditorResult> } => {
      const harness = makeEditor();

      harness.editor.setHistory(['SELECT Id FROM Account', '\\help', 'SELECT Name FROM Contact']);

      return { ...harness, read: harness.editor.readLine('soql> ') };
    };

    it('enters search mode on Ctrl+R and filters case-insensitively as you type', async () => {
      const { editor, output, press } = makeSearchEditor();

      await press(keys.ctrlR);
      assert.deepEqual(editor.search, { filter: '', match: '', failed: false });
      assert.equal(output.lastChunk.includes(searchPrompt('', '')), true);

      await press('sel');
      assert.deepEqual(editor.search, { filter: 'sel', match: 'SELECT Name FROM Contact', failed: false });
      assert.equal(output.lastChunk.includes(searchPrompt('sel', 'SELECT Name FROM Contact')), true);
    });

    it('keeps the typed line intact while searching', async () => {
      const { editor, press } = makeSearchEditor();

      await press('typed');
      await press(keys.ctrlR);
      await press('help');
      assert.equal(editor.search?.match, '\\help');
      assert.equal(editor.line, 'typed');
    });

    it('steps to older matches on repeated Ctrl+R and fails past the oldest', async () => {
      const { editor, output, press } = makeSearchEditor();

      await press(keys.ctrlR);
      await press('select');
      assert.equal(editor.search?.match, 'SELECT Name FROM Contact');

      await press(keys.ctrlR);
      assert.deepEqual(editor.search, { filter: 'select', match: 'SELECT Id FROM Account', failed: false });

      await press(keys.ctrlR);
      assert.deepEqual(editor.search, { filter: 'select', match: 'SELECT Id FROM Account', failed: true });
      assert.equal(output.lastChunk.includes(failedPrompt('select', 'SELECT Id FROM Account')), true);
    });

    it('steps through everything when the filter is empty', async () => {
      const { editor, press } = makeSearchEditor();

      await press(keys.ctrlR);
      await press(keys.ctrlR);
      assert.equal(editor.search?.match, 'SELECT Name FROM Contact');
      await press(keys.ctrlR);
      assert.equal(editor.search?.match, '\\help');
    });

    it('turns failed when nothing matches and recovers on Backspace', async () => {
      const { editor, press } = makeSearchEditor();

      await press(keys.ctrlR);
      await press('select');
      await press(keys.ctrlR);
      assert.equal(editor.search?.match, 'SELECT Id FROM Account');

      await press('z');
      assert.deepEqual(editor.search, { filter: 'selectz', match: 'SELECT Id FROM Account', failed: true });

      // Backspace shrinks the filter and stays on the match it was parked on.
      await press(keys.backspace);
      assert.deepEqual(editor.search, { filter: 'select', match: 'SELECT Id FROM Account', failed: false });
    });

    it('accepts into the editor on Enter without submitting; a second Enter submits', async () => {
      const { editor, press, read } = makeSearchEditor();

      await press(keys.ctrlR);
      await press('contact');
      await press(keys.enter);
      assert.equal(editor.search, undefined);
      assert.equal(editor.line, 'SELECT Name FROM Contact');
      assert.equal(editor.cursor, 'SELECT Name FROM Contact'.length);

      await press(keys.enter);
      assert.deepEqual(await read, { kind: 'line', text: 'SELECT Name FROM Contact' });
    });

    it('accepts into the editor on Tab and Right with the cursor at the end', async () => {
      const tab = makeSearchEditor();

      await tab.press(keys.ctrlR);
      await tab.press('help');
      await tab.press(keys.tab);
      assert.equal(tab.editor.search, undefined);
      assert.equal(tab.editor.line, '\\help');
      assert.equal(tab.editor.cursor, 5);
      assert.equal(tab.editor.menu, undefined);

      const right = makeSearchEditor();

      await right.press(keys.ctrlR);
      await right.press('help');
      await right.press(keys.right);
      assert.equal(right.editor.search, undefined);
      assert.equal(right.editor.line, '\\help');
      assert.equal(right.editor.cursor, 5);
    });

    it('cancels on Esc, Ctrl+C, and Ctrl+G, restoring the pre-search line', async () => {
      const cancels: Array<(harness: Harness) => Promise<void>> = [
        pressEscape,
        async (harness): Promise<void> => harness.press(keys.ctrlC),
        async (harness): Promise<void> => harness.press(keys.ctrlG),
      ];

      for (const cancel of cancels) {
        const harness = makeSearchEditor();

        // eslint-disable-next-line no-await-in-loop
        await harness.press('WHERE');
        // eslint-disable-next-line no-await-in-loop
        await harness.press(keys.ctrlR);
        // eslint-disable-next-line no-await-in-loop
        await harness.press('help');
        assert.equal(harness.editor.search?.match, '\\help');
        // eslint-disable-next-line no-await-in-loop
        await cancel(harness);
        assert.equal(harness.editor.search, undefined);
        assert.equal(harness.editor.line, 'WHERE');
      }
    });

    it('does not resolve the read when Ctrl+C cancels a search', async () => {
      const { editor, press } = makeEditor();
      const read = editor.readLine('soql> ');

      editor.setHistory(['SELECT one']);
      await press(keys.ctrlR);
      await press(keys.ctrlC);
      assert.equal(editor.search, undefined);

      await press(keys.enter);
      assert.deepEqual(await read, { kind: 'line', text: '' });
    });

    it('accepts the match and applies other editing keys', async () => {
      const { editor, press } = makeSearchEditor();

      await press(keys.ctrlR);
      await press('account');
      await press(keys.ctrlA);
      assert.equal(editor.search, undefined);
      assert.equal(editor.line, 'SELECT Id FROM Account');
      assert.equal(editor.cursor, 0);
    });

    it('is mutually exclusive with the completion menu', async () => {
      const { editor, press } = makeEditor({
        complete: (): [string[], string] => [['Name', 'NumberOfEmployees'], ''],
      });

      editor.setHistory(['SELECT one']);
      void editor.readLine('> ');
      await press(keys.tab);
      assert.notEqual(editor.menu, undefined);

      await press(keys.ctrlR);
      assert.equal(editor.menu, undefined);
      assert.notEqual(editor.search, undefined);
    });

    it('does nothing on Ctrl+R without history until something matches', async () => {
      const { editor, press } = makeEditor();

      editor.setHistory([]);
      void editor.readLine('> ');
      await press(keys.ctrlR);
      assert.deepEqual(editor.search, { filter: '', match: '', failed: false });

      await press('x');
      assert.deepEqual(editor.search, { filter: 'x', match: '', failed: true });
    });
  });

  describe('engagement gate', () => {
    const tty = { isTTY: true };
    const pipe = { isTTY: undefined };

    it('engages only when both streams are TTYs', () => {
      assert.equal(lineEditorEngages(tty, tty, {}), true);
      assert.equal(lineEditorEngages(pipe, tty, {}), false);
      assert.equal(lineEditorEngages(tty, pipe, {}), false);
    });

    it('stays plain on dumb terminals', () => {
      assert.equal(lineEditorEngages(tty, tty, { TERM: 'dumb' }), false);
      assert.equal(lineEditorEngages(tty, tty, { TERM: 'xterm-256color' }), true);
    });

    it('stays plain when RAVEN_SOQL_PLAIN is set', () => {
      assert.equal(lineEditorEngages(tty, tty, { RAVEN_SOQL_PLAIN: '1' }), false);
      assert.equal(lineEditorEngages(tty, tty, { RAVEN_SOQL_PLAIN: '' }), true);
    });
  });

  describe('raw mode and bracketed paste control', () => {
    it('toggles raw mode and paste mode around suspend/restore/close', () => {
      const modes: boolean[] = [];
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: (mode: boolean): void => {
          modes.push(mode);
        },
      });
      const output = new FakeOutput();
      const editor = new LineEditor({ input: input as unknown as LineEditorInput, output });

      assert.deepEqual(modes, [true]);
      assert.equal(output.text.includes(`${esc}[?2004h`), true);

      editor.suspend();
      assert.deepEqual(modes, [true, false]);
      assert.equal(output.text.includes(`${esc}[?2004l`), true);

      editor.restore();
      assert.deepEqual(modes, [true, false, true]);

      editor.close();
      assert.deepEqual(modes, [true, false, true, false]);
    });

    it('repaints an active line on restore', async () => {
      const { editor, output, press } = makeEditor();

      void editor.readLine('> ');
      await press('abc');
      editor.suspend();
      editor.restore();
      assert.equal(output.lastChunk, `\r${esc}[J> abc\r${esc}[5C`);
    });
  });
});
