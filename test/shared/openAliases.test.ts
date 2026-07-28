import assert from 'node:assert/strict';
import { aliasSearchTerms, builtInAliases, findAlias, mergeAliases } from '../../src/shared/openAliases.js';

describe('open aliases', () => {
  describe('builtInAliases', () => {
    it('stores paths relative to /lightning/setup/', () => {
      for (const [alias, definition] of Object.entries(builtInAliases)) {
        assert.equal(definition.path.startsWith('/'), false, alias);
        assert.equal(definition.path.includes('lightning'), false, alias);
      }
    });

    it('has no duplicate keys or synonyms', () => {
      const seen = new Set<string>();

      for (const [alias, definition] of Object.entries(builtInAliases)) {
        for (const term of [alias, ...(definition.synonyms ?? [])]) {
          assert.equal(seen.has(term), false, `duplicate term: ${term}`);
          seen.add(term);
        }
      }
    });
  });

  describe('findAlias', () => {
    it('matches an alias key case-insensitively', () => {
      assert.deepEqual(findAlias('PERM-SETS', builtInAliases), { alias: 'perm-sets', path: 'PermSets/home' });
    });

    it('matches a synonym', () => {
      assert.deepEqual(findAlias('psg', builtInAliases), {
        alias: 'perm-set-groups',
        path: 'PermSetGroups/home',
      });
      assert.deepEqual(findAlias('classes', builtInAliases), { alias: 'apex-classes', path: 'ApexClasses/home' });
    });

    it('prefers an alias key over another entry that has it as a synonym', () => {
      const aliases = {
        deploy: { path: 'MyDeploy/home' },
        'deploy-status': { path: 'DeployStatus/home', synonyms: ['deploy'] },
      };

      assert.deepEqual(findAlias('deploy', aliases), { alias: 'deploy', path: 'MyDeploy/home' });
    });

    it('returns nothing for an unknown name', () => {
      assert.equal(findAlias('not-a-page', builtInAliases), undefined);
    });
  });

  describe('mergeAliases', () => {
    it('keeps the built-ins when there is no project config', () => {
      assert.deepEqual(mergeAliases(undefined), { ...builtInAliases });
    });

    it('adds project aliases', () => {
      const merged = mergeAliases({ einstein: 'EinsteinGPT/home' });

      assert.deepEqual(findAlias('einstein', merged), { alias: 'einstein', path: 'EinsteinGPT/home' });
      assert.deepEqual(findAlias('users', merged), { alias: 'users', path: 'ManageUsers/home' });
    });

    it('lets a project alias win over a built-in of the same name', () => {
      const merged = mergeAliases({ USERS: 'MyUsers/home' });

      assert.deepEqual(findAlias('users', merged), { alias: 'users', path: 'MyUsers/home' });
    });

    it('ignores entries that are not usable paths', () => {
      const merged = mergeAliases({ blank: '', bogus: 42 as unknown as string });

      assert.equal(findAlias('blank', merged), undefined);
      assert.equal(findAlias('bogus', merged), undefined);
    });
  });

  describe('aliasSearchTerms', () => {
    it('lists the key and every synonym for each alias', () => {
      const terms = aliasSearchTerms(builtInAliases);

      assert.deepEqual(terms.get('perm-sets'), ['perm-sets', 'permissions', 'permission-sets', 'ps']);
      assert.deepEqual(terms.get('roles'), ['roles']);
    });
  });
});
