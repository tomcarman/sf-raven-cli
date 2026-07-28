import assert from 'node:assert/strict';
import {
  buildAliasTarget,
  buildApexClassTarget,
  buildFlowTarget,
  buildRecordTarget,
  buildSObjectTarget,
  fuzzyCandidates,
  matchSObjects,
  openerCommand,
  sobjectBaseName,
} from '../../src/shared/open.js';
import { builtInAliases } from '../../src/shared/openAliases.js';

describe('open targets', () => {
  describe('buildRecordTarget', () => {
    it('opens the bare id so Salesforce picks the right view', () => {
      assert.deepEqual(buildRecordTarget('0015g00000ABCDEfGH'), {
        kind: 'record',
        name: '0015g00000ABCDEfGH',
        path: '/0015g00000ABCDEfGH',
      });
    });
  });

  describe('buildSObjectTarget', () => {
    it('points at the Object Manager details page', () => {
      assert.deepEqual(buildSObjectTarget('Invoice__c'), {
        kind: 'sobject',
        name: 'Invoice__c',
        path: '/lightning/setup/ObjectManager/Invoice__c/Details/view',
      });
    });
  });

  describe('buildAliasTarget', () => {
    it('prefixes the alias path with the Setup root', () => {
      assert.deepEqual(buildAliasTarget('perm-sets', 'PermSets/home'), {
        kind: 'alias',
        name: 'perm-sets',
        path: '/lightning/setup/PermSets/home',
      });
    });
  });

  describe('sobjectBaseName', () => {
    it('leaves standard object names alone', () => {
      assert.equal(sobjectBaseName('Account'), 'Account');
    });

    it('strips the custom suffix', () => {
      assert.equal(sobjectBaseName('Invoice__c'), 'Invoice');
      assert.equal(sobjectBaseName('Setting__mdt'), 'Setting');
      assert.equal(sobjectBaseName('Order_Event__e'), 'Order_Event');
    });

    it('strips the namespace as well as the suffix', () => {
      assert.equal(sobjectBaseName('acme__Invoice__c'), 'Invoice');
    });
  });

  describe('matchSObjects', () => {
    const sobjects = [
      { name: 'Account', label: 'Account' },
      { name: 'Invoice__c', label: 'Invoice' },
      { name: 'acme__Invoice__c', label: 'Managed Invoice' },
      { name: 'Legacy_Invoice__c', label: 'Invoice' },
    ];

    it('matches the API name case-insensitively', () => {
      assert.deepEqual(matchSObjects('account', sobjects), [{ name: 'Account', label: 'Account' }]);
    });

    it('prefers an exact API name over a base-name or label match', () => {
      assert.deepEqual(matchSObjects('Invoice__c', sobjects), [{ name: 'Invoice__c', label: 'Invoice' }]);
    });

    it('falls back to the name without namespace or suffix, returning every hit', () => {
      assert.deepEqual(
        matchSObjects('invoice', sobjects).map((match) => match.name),
        ['Invoice__c', 'acme__Invoice__c']
      );
    });

    it('falls back to the label when nothing matches by name', () => {
      assert.deepEqual(
        matchSObjects('managed invoice', sobjects).map((match) => match.name),
        ['acme__Invoice__c']
      );
    });

    it('returns nothing when no tier matches', () => {
      assert.deepEqual(matchSObjects('perm-sets', sobjects), []);
    });
  });

  describe('buildApexClassTarget', () => {
    it('routes through the Setup class list with an encoded classic address', () => {
      assert.deepEqual(buildApexClassTarget('AccountHandler', '01p5g00000XyZaBAAV'), {
        kind: 'apexClass',
        name: 'AccountHandler',
        path: '/lightning/setup/ApexClasses/page?address=%2F01p5g00000XyZaBAAV',
      });
    });
  });

  describe('buildFlowTarget', () => {
    it('opens the latest version in Flow Builder', () => {
      assert.deepEqual(buildFlowTarget('Send_Welcome_Email', '3015g000000XyZaAAK'), {
        kind: 'flow',
        name: 'Send_Welcome_Email',
        path: '/builder_platform_interaction/flowBuilder.app?flowId=3015g000000XyZaAAK',
      });
    });
  });

  describe('fuzzyCandidates', () => {
    const sobjects = [
      { name: 'Account', label: 'Account' },
      { name: 'AccountContactRole', label: 'Account Contact Role' },
      { name: 'Invoice__c', label: 'Invoice' },
    ];

    it('matches aliases by substring of the key or a synonym', () => {
      const labels = fuzzyCandidates('perm', builtInAliases, [], 'Setup page').map((candidate) => candidate.label);

      assert.deepEqual(labels, ['perm-set-groups (Setup page)', 'perm-sets (Setup page)']);
    });

    it('matches sObjects by substring of the API name or label', () => {
      const names = fuzzyCandidates('accou', builtInAliases, sobjects, 'Setup page').map((candidate) => candidate.target.name);

      assert.deepEqual(names, ['Account', 'AccountContactRole']);
    });

    it('is case-insensitive', () => {
      assert.equal(fuzzyCandidates('INVOI', builtInAliases, sobjects, 'Setup page').length, 1);
    });

    it('lists alias hits before sObject hits', () => {
      const kinds = fuzzyCandidates('class', builtInAliases, [{ name: 'ApexClassMirror__c', label: 'Apex Class Mirror' }], 'Setup page').map((candidate) => candidate.target.kind);

      assert.deepEqual(kinds, ['alias', 'sobject']);
    });

    it('returns nothing when the name matches no category', () => {
      assert.deepEqual(fuzzyCandidates('zzzzz', builtInAliases, sobjects, 'Setup page'), []);
    });

    it('reports each alias once even when the key and a synonym both match', () => {
      const candidates = fuzzyCandidates('perm-sets', builtInAliases, [], 'Setup page');

      assert.deepEqual(
        candidates.map((candidate) => candidate.target.name),
        ['perm-sets']
      );
    });
  });

  describe('openerCommand', () => {
    it('uses open on macOS', () => {
      assert.deepEqual(openerCommand('darwin', 'https://example.test'), {
        command: 'open',
        args: ['https://example.test'],
      });
    });

    it('uses start with an empty title argument on Windows', () => {
      assert.deepEqual(openerCommand('win32', 'https://example.test'), {
        command: 'cmd',
        args: ['/c', 'start', '', 'https://example.test'],
      });
    });

    it('falls back to xdg-open everywhere else', () => {
      assert.deepEqual(openerCommand('linux', 'https://example.test'), {
        command: 'xdg-open',
        args: ['https://example.test'],
      });
    });
  });
});
