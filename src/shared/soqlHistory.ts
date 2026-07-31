import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * History lives under the oclif dataDir (user data, survives cache clears),
 * one file per org so sandbox and production recall stay separate.
 */
export const soqlHistoryPath = (dataDir: string, orgId: string): string =>
  join(dataDir, 'raven', 'soql-history', `${orgId}.txt`);

/** Loads history entries oldest-first; a missing file is an empty history. */
export const loadSoqlHistory = async (path: string): Promise<string[]> => {
  try {
    const contents = await readFile(path, 'utf8');

    return contents.split('\n').filter((line) => line.trim() !== '');
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

export const saveSoqlHistory = async (path: string, entries: readonly string[]): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, entries.length === 0 ? '' : `${entries.join('\n')}\n`, 'utf8');
};
