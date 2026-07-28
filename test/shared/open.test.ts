import assert from 'node:assert/strict';
import {
  buildAliasTarget,
  buildRecordTarget,
  buildSObjectTarget,
  isRecordId,
  matchSObjects,
  openerCommand,
  sobjectBaseName,
} from '../../src/shared/open.js';

describe('open targets', () => {
  describe('isRecordId', () => {
    it('accepts 15- and 18-character ids', () => {
      assert.equal(isRecordId('0015g00000ABCDE'), true);
      assert.equal(isRecordId('0015g00000ABCDEfGH'), true);
    });

    it('accepts tooling object ids', () => {
      assert.equal(isRecordId('01p5g00000XyZaBAAV'), true);
    });

    it('rejects lengths either side of 15 and 18', () => {
      for (const candidate of ['0015g00000ABCD', '0015g00000ABCDEf', '0015g00000ABCDEfGHI']) {
        assert.equal(isRecordId(candidate), false, candidate);
      }
    });

    it('rejects anything that is not alphanumeric', () => {
      assert.equal(isRecordId('Account'), false);
      assert.equal(isRecordId('perm-sets-aaaaa'), false);
      assert.equal(isRecordId('My_Object__c___'), false);
    });
  });

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
