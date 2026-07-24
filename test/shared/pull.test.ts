import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getComponentInventory, getOrgTypeInventory, getTypeInventory } from '../../src/shared/pull.js';

type ProjectOptions = {
  configuredMetadataTypes?: string[];
};

const createProject = (options: ProjectOptions = {}): string => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'sf-raven-pull-test-'));
  const sfdxProject: Record<string, unknown> = {
    packageDirectories: [{ path: 'force-app', default: true }],
    sourceApiVersion: '61.0',
  };

  if (options.configuredMetadataTypes != null) {
    sfdxProject['plugins'] = {
      'sf-raven': {
        pullRemote: {
          metadataTypes: options.configuredMetadataTypes,
        },
      },
    };
  }

  writeFileSync(join(projectRoot, 'sfdx-project.json'), JSON.stringify(sfdxProject, null, 2));

  const classesDir = join(projectRoot, 'force-app', 'main', 'default', 'classes');
  const triggersDir = join(projectRoot, 'force-app', 'main', 'default', 'triggers');
  mkdirSync(classesDir, { recursive: true });
  mkdirSync(triggersDir, { recursive: true });

  writeApexClass(classesDir, 'LocalOnly');
  writeApexClass(classesDir, 'SharedClass');
  writeApexTrigger(triggersDir, 'AccountTrigger');

  return projectRoot;
};

const writeApexClass = (classesDir: string, name: string): void => {
  writeFileSync(join(classesDir, `${name}.cls`), `public class ${name} {}\n`);
  writeFileSync(
    join(classesDir, `${name}.cls-meta.xml`),
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>61.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n'
  );
};

const writeApexTrigger = (triggersDir: string, name: string): void => {
  writeFileSync(join(triggersDir, `${name}.trigger`), `trigger ${name} on Account (before insert) {}\n`);
  writeFileSync(
    join(triggersDir, `${name}.trigger-meta.xml`),
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>61.0</apiVersion>\n    <status>Active</status>\n</ApexTrigger>\n'
  );
};

const createFakeSfBinary = (directory: string): { binPath: string; argsPath: string } => {
  const binPath = join(directory, 'fake-sf');
  const argsPath = join(directory, 'sf-args.txt');
  const script = [
    '#!/usr/bin/env bash',
    `echo "$@" >> "${argsPath}"`,
    'if [[ "$*" == *"metadata-types"* ]]; then',
    '  echo \'{"status":0,"result":{"metadataObjects":[{"xmlName":"CustomObject"},{"xmlName":"ApexClass"}]}}\'',
    'elif [[ "$*" == *"list metadata"* ]]; then',
    '  echo \'{"status":0,"result":[{"fullName":"SharedClass"},{"fullName":"RemoteOnly"}]}\'',
    'fi',
    '',
  ].join('\n');

  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);

  return { binPath, argsPath };
};

const createFailingSfBinary = (directory: string, stdout: string): string => {
  const binPath = join(directory, 'fake-sf-failing');
  const script = ['#!/usr/bin/env bash', `echo '${stdout}'`, 'exit 1', ''].join('\n');

  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);

  return binPath;
};

describe('pull list inventory', () => {
  const projectRoots: string[] = [];
  const originalSfBinPath = process.env.SF_BINPATH;

  const trackProject = (projectRoot: string): string => {
    projectRoots.push(projectRoot);
    return projectRoot;
  };

  afterEach(() => {
    if (originalSfBinPath == null) {
      delete process.env.SF_BINPATH;
    } else {
      process.env.SF_BINPATH = originalSfBinPath;
    }
  });

  after(() => {
    for (const projectRoot of projectRoots) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  describe('getTypeInventory', () => {
    it('returns configured types with local counts when plugin config exists', async () => {
      const projectRoot = trackProject(createProject({ configuredMetadataTypes: ['CustomObject', 'ApexClass'] }));

      const inventory = await getTypeInventory(projectRoot);

      assert.deepEqual(inventory, {
        source: 'configured',
        types: [
          { name: 'ApexClass', localCount: 2 },
          { name: 'CustomObject', localCount: 0 },
        ],
      });
    });

    it('falls back to local types with counts when no plugin config exists', async () => {
      const projectRoot = trackProject(createProject());

      const inventory = await getTypeInventory(projectRoot);

      assert.deepEqual(inventory, {
        source: 'local',
        types: [
          { name: 'ApexClass', localCount: 2 },
          { name: 'ApexTrigger', localCount: 1 },
        ],
      });
    });

    it('does not invoke the sf CLI', async () => {
      const projectRoot = trackProject(createProject());
      const { binPath, argsPath } = createFakeSfBinary(projectRoot);
      process.env.SF_BINPATH = binPath;

      await getTypeInventory(projectRoot);

      assert.equal(existsSync(argsPath), false);
    });
  });

  describe('getOrgTypeInventory', () => {
    it('returns sorted org types without local counts', async () => {
      const projectRoot = trackProject(createProject());
      const { binPath } = createFakeSfBinary(projectRoot);
      process.env.SF_BINPATH = binPath;

      const inventory = await getOrgTypeInventory();

      assert.deepEqual(inventory, {
        source: 'org',
        types: [{ name: 'ApexClass' }, { name: 'CustomObject' }],
      });
      assert.equal('localCount' in inventory.types[0], false);
    });

    it('passes --target-org to the sf CLI', async () => {
      const projectRoot = trackProject(createProject());
      const { binPath, argsPath } = createFakeSfBinary(projectRoot);
      process.env.SF_BINPATH = binPath;

      await getOrgTypeInventory('my-org');

      assert.match(readFileSync(argsPath, 'utf8'), /--target-org my-org/);
    });

    it('surfaces the sf CLI error when the command fails', async () => {
      const projectRoot = trackProject(createProject());
      process.env.SF_BINPATH = createFailingSfBinary(
        projectRoot,
        '{"name":"NoDefaultEnvError","message":"No default environment found. Use -o or --target-org to specify an environment.","status":1}'
      );

      await assert.rejects(getOrgTypeInventory(), (error: Error) => {
        assert.equal(error.name, 'NoDefaultEnvError');
        assert.match(error.message, /No default environment found/);
        assert.match(error.message, /sf org list metadata-types --json/);
        return true;
      });
    });

    it('reports the exit code when the sf CLI fails without JSON output', async () => {
      const projectRoot = trackProject(createProject());
      process.env.SF_BINPATH = createFailingSfBinary(projectRoot, 'not json');

      await assert.rejects(getOrgTypeInventory(), /failed with exit code 1/);
    });
  });

  describe('getComponentInventory', () => {
    it('merges local and org components with local, remote, and both statuses', async () => {
      const projectRoot = trackProject(createProject());
      const { binPath } = createFakeSfBinary(projectRoot);
      process.env.SF_BINPATH = binPath;

      const inventory = await getComponentInventory(projectRoot, 'ApexClass');

      assert.deepEqual(inventory, {
        metadataType: 'ApexClass',
        components: [
          { name: 'LocalOnly', status: 'local' },
          { name: 'RemoteOnly', status: 'remote' },
          { name: 'SharedClass', status: 'both' },
        ],
      });
    });

    it('passes --target-org to the sf CLI', async () => {
      const projectRoot = trackProject(createProject());
      const { binPath, argsPath } = createFakeSfBinary(projectRoot);
      process.env.SF_BINPATH = binPath;

      await getComponentInventory(projectRoot, 'ApexClass', 'my-org');

      assert.match(readFileSync(argsPath, 'utf8'), /--target-org my-org/);
    });

    it('surfaces the sf CLI error when the command fails', async () => {
      const projectRoot = trackProject(createProject());
      process.env.SF_BINPATH = createFailingSfBinary(
        projectRoot,
        '{"name":"NoDefaultEnvError","message":"No default environment found. Use -o or --target-org to specify an environment.","status":1}'
      );

      await assert.rejects(getComponentInventory(projectRoot, 'ApexClass'), (error: Error) => {
        assert.equal(error.name, 'NoDefaultEnvError');
        assert.match(error.message, /No default environment found/);
        return true;
      });
    });
  });
});
