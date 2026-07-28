import assert from 'node:assert/strict';
import { buildRecordTarget, isRecordId, openerCommand } from '../../src/shared/open.js';

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
