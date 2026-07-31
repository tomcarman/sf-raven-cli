import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  DescribeCache,
  describeCacheDirectory,
  describeCacheTtlMs,
  type DescribeClient,
} from '../../src/shared/describeCache.js';
import type { CompletionObject } from '../../src/shared/soqlComplete.js';

const accountDescribe = {
  name: 'Account',
  fields: [
    { name: 'Id', relationshipName: null, referenceTo: [], picklistValues: [] },
    { name: 'OwnerId', relationshipName: 'Owner', referenceTo: ['User'], picklistValues: [] },
    {
      name: 'Industry',
      relationshipName: null,
      referenceTo: [],
      picklistValues: [{ value: 'Banking', active: true }],
    },
  ],
  childRelationships: [
    { relationshipName: 'Contacts', childSObject: 'Contact' },
    { relationshipName: null, childSObject: 'AccountFeed' },
  ],
};

type CountingClient = DescribeClient & { globalCalls: () => number; objectCalls: () => string[] };

const makeClient = (
  globals: Array<{ name: string; queryable?: boolean }>,
  objects: Record<string, unknown> = {}
): CountingClient => {
  let globalCalls = 0;
  const objectCalls: string[] = [];

  return {
    describeGlobal: async () => {
      globalCalls += 1;

      return { sobjects: globals };
    },
    describeSObject: async (name: string) => {
      objectCalls.push(name);
      const object = objects[name];

      if (object == null) {
        throw new Error(`no describe for ${name}`);
      }

      return object as never;
    },
    globalCalls: () => globalCalls,
    objectCalls: () => [...objectCalls],
  };
};

const failingClient: DescribeClient = {
  describeGlobal: async () => {
    throw new Error('should not be called');
  },
  describeSObject: async () => {
    throw new Error('should not be called');
  },
};

describe('describeCacheDirectory', () => {
  it('nests by org and API version under the cache directory', () => {
    const path = describeCacheDirectory('/cache', '00D01', '61.0');

    assert.equal(path, join('/cache', 'raven', 'describes', '00D01', '61.0'));
  });
});

describe('DescribeCache', () => {
  let directory: string;

  beforeEach(async () => {
    directory = join(await mkdtemp(join(tmpdir(), 'raven-describes-')), 'org', '61.0');
  });

  afterEach(async () => {
    await rm(directory.split(sep).slice(0, -2).join(sep), { recursive: true, force: true });
  });

  it('reports no global names until warm-up settles, then the merged union', async () => {
    const cache = new DescribeCache({
      directory,
      regular: makeClient([{ name: 'Account' }, { name: 'ApexClass' }]),
      tooling: makeClient([{ name: 'ApexClass' }, { name: 'EntityDefinition' }]),
    });

    assert.equal(cache.globalObjectNames(), undefined);

    await cache.warm();

    assert.deepEqual(cache.globalObjectNames(), ['Account', 'ApexClass', 'EntityDefinition']);
  });

  it('excludes non-queryable objects', async () => {
    const cache = new DescribeCache({
      directory,
      regular: makeClient([{ name: 'Account' }, { name: 'DeletedThing', queryable: false }]),
      tooling: makeClient([]),
    });

    await cache.warm();

    assert.deepEqual(cache.globalObjectNames(), ['Account']);
  });

  it('serves globals from disk within the TTL without touching the API', async () => {
    const first = new DescribeCache({
      directory,
      regular: makeClient([{ name: 'Account' }]),
      tooling: makeClient([{ name: 'EntityDefinition' }]),
    });

    await first.warm();

    const second = new DescribeCache({ directory, regular: failingClient, tooling: failingClient });

    await second.warm();

    assert.deepEqual(second.globalObjectNames(), ['Account', 'EntityDefinition']);
  });

  it('re-fetches globals once the disk entry is older than the TTL', async () => {
    const start = 1_000_000;
    const first = new DescribeCache({
      directory,
      regular: makeClient([{ name: 'Account' }]),
      tooling: makeClient([]),
      now: () => start,
    });

    await first.warm();

    const regular = makeClient([{ name: 'Account' }, { name: 'NewThing' }]);
    const second = new DescribeCache({
      directory,
      regular,
      tooling: makeClient([]),
      now: () => start + describeCacheTtlMs + 1,
    });

    await second.warm();

    assert.equal(regular.globalCalls(), 1);
    assert.deepEqual(second.globalObjectNames(), ['Account', 'NewThing']);
  });

  it('returns undefined for an unloaded object and loads it in the background', async () => {
    const cache = new DescribeCache({
      directory,
      regular: makeClient([{ name: 'Account' }], { Account: accountDescribe }),
      tooling: makeClient([]),
    });

    await cache.warm();

    assert.equal(cache.getObject('Account'), undefined);

    await cache.loadObject('Account');

    const loaded = cache.getObject('Account') as CompletionObject;

    assert.equal(loaded.name, 'Account');
    assert.deepEqual(
      loaded.fields.find((field) => field.name === 'OwnerId'),
      { name: 'OwnerId', relationshipName: 'Owner', referenceTo: ['User'] }
    );
    assert.deepEqual(loaded.childRelationships, [{ relationshipName: 'Contacts', childSObject: 'Contact' }]);
  });

  it('waits for the globals before locating an object requested pre-warm-up', async () => {
    const regular = makeClient([{ name: 'Account' }], { Account: accountDescribe });
    const cache = new DescribeCache({ directory, regular, tooling: makeClient([]) });

    assert.equal((await cache.loadObject('account'))?.name, 'Account');
    assert.deepEqual(regular.objectCalls(), ['Account']);
    assert.deepEqual(await readdir(join(directory, 'sobjects')), ['Account.json']);
  });

  it('resolves objects case-insensitively to their canonical name', async () => {
    const regular = makeClient([{ name: 'Account' }], { Account: accountDescribe });
    const cache = new DescribeCache({ directory, regular, tooling: makeClient([]) });

    await cache.warm();
    await cache.loadObject('ACCOUNT');

    assert.equal(regular.objectCalls()[0], 'Account');
    assert.equal(cache.getObject('account')?.name, 'Account');
  });

  it('dedupes concurrent loads of the same object', async () => {
    const regular = makeClient([{ name: 'Account' }], { Account: accountDescribe });
    const cache = new DescribeCache({ directory, regular, tooling: makeClient([]) });

    await cache.warm();
    await Promise.all([cache.loadObject('Account'), cache.loadObject('Account')]);

    assert.equal(regular.objectCalls().length, 1);
  });

  it('serves object describes from disk across instances', async () => {
    const first = new DescribeCache({
      directory,
      regular: makeClient([{ name: 'Account' }], { Account: accountDescribe }),
      tooling: makeClient([]),
    });

    await first.warm();
    await first.loadObject('Account');

    const second = new DescribeCache({
      directory,
      regular: makeClient([{ name: 'Account' }]),
      tooling: makeClient([]),
    });

    await second.warm();

    assert.equal((await second.loadObject('Account'))?.name, 'Account');
  });

  it('fetches tooling-only objects through the tooling client', async () => {
    const tooling = makeClient([{ name: 'EntityDefinition' }], {
      EntityDefinition: { name: 'EntityDefinition', fields: [{ name: 'QualifiedApiName' }], childRelationships: [] },
    });
    const cache = new DescribeCache({ directory, regular: makeClient([{ name: 'Account' }]), tooling });

    await cache.warm();
    await cache.loadObject('EntityDefinition');

    assert.deepEqual(tooling.objectCalls(), ['EntityDefinition']);
    assert.deepEqual(await readdir(join(directory, 'tooling')), ['EntityDefinition.json']);
  });

  it('lets the tooling describe win name conflicts only when preferred', async () => {
    const regular = makeClient([{ name: 'ApexClass' }], {
      ApexClass: { name: 'ApexClass', fields: [{ name: 'RegularField' }], childRelationships: [] },
    });
    const tooling = makeClient([{ name: 'ApexClass' }], {
      ApexClass: { name: 'ApexClass', fields: [{ name: 'ToolingField' }], childRelationships: [] },
    });
    const cache = new DescribeCache({ directory, regular, tooling });

    await cache.warm();
    await cache.loadObject('ApexClass');

    assert.equal(cache.getObject('ApexClass')?.fields[0].name, 'RegularField');

    cache.setToolingPreferred(true);
    await cache.loadObject('ApexClass');

    assert.equal(cache.getObject('ApexClass')?.fields[0].name, 'ToolingField');
  });

  it('reports tooling-only objects for query routing', async () => {
    const cache = new DescribeCache({
      directory,
      regular: makeClient([{ name: 'Account' }]),
      tooling: makeClient([{ name: 'EntityDefinition' }]),
    });

    assert.equal(cache.isToolingOnly('EntityDefinition'), undefined);

    await cache.warm();

    assert.equal(cache.isToolingOnly('EntityDefinition'), true);
    assert.equal(cache.isToolingOnly('Account'), false);
    assert.equal(cache.isToolingOnly('Bogus'), false);
  });

  it('refresh clears disk and memory and re-fetches globals', async () => {
    const regular = makeClient([{ name: 'Account' }], { Account: accountDescribe });
    const cache = new DescribeCache({ directory, regular, tooling: makeClient([]) });

    await cache.warm();
    await cache.loadObject('Account');
    await cache.refresh();

    assert.equal(regular.globalCalls(), 2);
    assert.equal(cache.getObject('Account'), undefined);
    assert.deepEqual(await readdir(directory), ['global.json', 'tooling-global.json']);
  });

  it('keeps working when a global describe fails', async () => {
    const cache = new DescribeCache({
      directory,
      regular: makeClient([{ name: 'Account' }]),
      tooling: failingClient,
    });

    await cache.warm();

    assert.deepEqual(cache.globalObjectNames(), ['Account']);
    assert.equal(cache.isToolingOnly('Account'), false);
  });

  it('returns undefined when an object describe fails', async () => {
    const cache = new DescribeCache({
      directory,
      regular: makeClient([{ name: 'Account' }]),
      tooling: makeClient([]),
    });

    await cache.warm();

    assert.equal(await cache.loadObject('Account'), undefined);
    assert.equal(cache.getObject('Account'), undefined);
  });

  it('refuses to cache names that would not be safe file names', async () => {
    const cache = new DescribeCache({
      directory,
      regular: makeClient([]),
      tooling: makeClient([]),
    });

    await cache.warm();

    assert.equal(await cache.loadObject('../../etc/passwd'), undefined);
  });
});
