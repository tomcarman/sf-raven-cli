import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { loadSoqlHistory, saveSoqlHistory, soqlHistoryPath } from '../../src/shared/soqlHistory.js';

describe('soqlHistory', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'raven-soql-history-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('builds a per-org path under the data directory', () => {
    const path = soqlHistoryPath(dataDir, '00D000000000001EAA');

    assert.equal(path, join(dataDir, 'raven', 'soql-history', '00D000000000001EAA.txt'));
    assert.ok(path.startsWith(`${dataDir}${sep}`));
  });

  it('returns an empty history when the file does not exist', async () => {
    assert.deepEqual(await loadSoqlHistory(soqlHistoryPath(dataDir, 'missing')), []);
  });

  it('round-trips entries, creating parent directories', async () => {
    const path = soqlHistoryPath(dataDir, '00D000000000001EAA');
    const entries = ['SELECT Id FROM Account', '\\limit 500', 'SELECT Id FROM Contact'];

    await saveSoqlHistory(path, entries);

    assert.deepEqual(await loadSoqlHistory(path), entries);
  });

  it('skips blank lines when loading', async () => {
    const path = soqlHistoryPath(dataDir, '00D000000000001EAA');

    await saveSoqlHistory(path, ['a', '', '  ', 'b']);

    assert.deepEqual(await loadSoqlHistory(path), ['a', 'b']);
  });

  it('writes an empty file for an empty history', async () => {
    const path = soqlHistoryPath(dataDir, '00D000000000001EAA');

    await saveSoqlHistory(path, []);

    assert.equal(await readFile(path, 'utf8'), '');
  });
});
