import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addExcludedSections,
  getConfiguredExcludedSections,
  removeExcludedSections,
} from '../../src/shared/profileSyncConfig.js';

const createProject = (): string => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'sf-raven-profile-sync-config-test-'));
  writeFileSync(
    join(projectRoot, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '61.0' }, null, 2)
  );

  return projectRoot;
};

describe('profile sync config', () => {
  const projectRoots: string[] = [];

  const trackProject = (projectRoot: string): string => {
    projectRoots.push(projectRoot);
    return projectRoot;
  };

  after(() => {
    for (const projectRoot of projectRoots) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns no exclusions for a project without configuration', async () => {
    const projectRoot = trackProject(createProject());

    assert.deepEqual(await getConfiguredExcludedSections(projectRoot), []);
  });

  it('returns no exclusions outside an sfdx project', async () => {
    const projectRoot = trackProject(mkdtempSync(join(tmpdir(), 'sf-raven-not-a-project-')));

    assert.deepEqual(await getConfiguredExcludedSections(projectRoot), []);
  });

  it('persists added sections sorted and deduped in sfdx-project.json', async () => {
    const projectRoot = trackProject(createProject());

    const excludedSections = await addExcludedSections(projectRoot, ['flowAccesses', 'agentAccesses', 'flowAccesses']);

    assert.deepEqual(excludedSections, ['agentAccesses', 'flowAccesses']);
    assert.deepEqual(await getConfiguredExcludedSections(projectRoot), ['agentAccesses', 'flowAccesses']);

    const sfdxProject = JSON.parse(readFileSync(join(projectRoot, 'sfdx-project.json'), 'utf8')) as {
      plugins?: { 'sf-raven'?: { profileSync?: { excludedSections?: string[] } } };
    };
    assert.deepEqual(sfdxProject.plugins?.['sf-raven']?.profileSync?.excludedSections, [
      'agentAccesses',
      'flowAccesses',
    ]);
  });

  it('removes configured sections and reports values that were not excluded', async () => {
    const projectRoot = trackProject(createProject());
    await addExcludedSections(projectRoot, ['flowAccesses', 'layoutAssignments']);

    const result = await removeExcludedSections(projectRoot, ['flowAccesses', 'notConfigured']);

    assert.deepEqual(result, {
      excludedSections: ['layoutAssignments'],
      removedSections: ['flowAccesses'],
      missingSections: ['notConfigured'],
    });
    assert.deepEqual(await getConfiguredExcludedSections(projectRoot), ['layoutAssignments']);
  });
});
