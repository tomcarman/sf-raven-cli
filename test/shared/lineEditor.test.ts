import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LineEditor, type LineEditorInput } from '../../src/shared/lineEditor.js';

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
