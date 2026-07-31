import assert from 'node:assert/strict';
import {
  appendSoqlHistory,
  applySoqlAutoLimit,
  buildSoqlFooter,
  collapseSoqlQuery,
  endsInsideSoqlString,
  formatSoqlExecutionError,
  formatSoqlQueryError,
  isBareCountQuery,
  isSoqlInputComplete,
  parseSoqlMetaLine,
  renderSoqlTable,
  shapeSoqlRecords,
  splitCommandLine,
} from '../../src/shared/soqlRepl.js';
import { stripAnsi } from '../../src/shared/table.js';

describe('isSoqlInputComplete', () => {
  it('treats a simple query as complete', () => {
    assert.equal(isSoqlInputComplete('SELECT Id FROM Account'), true);
  });

  it('waits for a closing paren', () => {
    assert.equal(isSoqlInputComplete('SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact'), false);
    assert.equal(isSoqlInputComplete('SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)'), true);
  });

  it('waits for a closing quote', () => {
    assert.equal(isSoqlInputComplete("SELECT Id FROM Account WHERE Name = 'Acme"), false);
    assert.equal(isSoqlInputComplete("SELECT Id FROM Account WHERE Name = 'Acme'"), true);
  });

  it('ignores parens inside string literals', () => {
    assert.equal(isSoqlInputComplete("SELECT Id FROM Account WHERE Name = '(unclosed'"), true);
  });

  it('ignores an escaped quote inside a string literal', () => {
    assert.equal(isSoqlInputComplete("SELECT Id FROM Account WHERE Name = 'O\\'Brien'"), true);
    assert.equal(isSoqlInputComplete("SELECT Id FROM Account WHERE Name = 'O\\'Brien"), false);
  });

  it('spans multiple lines', () => {
    assert.equal(isSoqlInputComplete('SELECT Id, (SELECT Id\nFROM Contacts'), false);
    assert.equal(isSoqlInputComplete('SELECT Id, (SELECT Id\nFROM Contacts)\nFROM Account'), true);
  });
});

describe('collapseSoqlQuery', () => {
  it('joins lines and squeezes whitespace', () => {
    assert.equal(collapseSoqlQuery('SELECT Id\n  FROM   Account\n'), 'SELECT Id FROM Account');
  });

  it('preserves whitespace inside string literals', () => {
    assert.equal(
      collapseSoqlQuery("SELECT Id\nFROM Account WHERE Name = 'two  spaces'"),
      "SELECT Id FROM Account WHERE Name = 'two  spaces'"
    );
  });
});

describe('parseSoqlMetaLine', () => {
  it('parses bare commands', () => {
    assert.deepEqual(parseSoqlMetaLine('\\help'), { type: 'help' });
    assert.deepEqual(parseSoqlMetaLine('\\q'), { type: 'quit' });
    assert.deepEqual(parseSoqlMetaLine('\\e'), { type: 'editor' });
    assert.deepEqual(parseSoqlMetaLine('\\refresh'), { type: 'refresh' });
  });

  it('parses \\limit with a non-negative integer', () => {
    assert.deepEqual(parseSoqlMetaLine('\\limit 500'), { type: 'limit', value: 500 });
    assert.deepEqual(parseSoqlMetaLine('\\limit 0'), { type: 'limit', value: 0 });
    assert.equal(parseSoqlMetaLine('\\limit -1').type, 'invalid');
    assert.equal(parseSoqlMetaLine('\\limit ten').type, 'invalid');
    assert.equal(parseSoqlMetaLine('\\limit').type, 'invalid');
  });

  it('parses \\format with a known format', () => {
    assert.deepEqual(parseSoqlMetaLine('\\format csv'), { type: 'format', value: 'csv' });
    assert.equal(parseSoqlMetaLine('\\format xml').type, 'invalid');
    assert.equal(parseSoqlMetaLine('\\format').type, 'invalid');
  });

  it('parses \\csv with a path that may contain spaces', () => {
    assert.deepEqual(parseSoqlMetaLine('\\csv /tmp/my out.csv'), { type: 'csv', path: '/tmp/my out.csv' });
    assert.equal(parseSoqlMetaLine('\\csv').type, 'invalid');
  });

  it('parses \\fields, \\open and \\record', () => {
    assert.deepEqual(parseSoqlMetaLine('\\fields Account'), { type: 'fields', sobject: 'Account' });
    assert.deepEqual(parseSoqlMetaLine('\\open 3'), { type: 'open', row: 3 });
    assert.deepEqual(parseSoqlMetaLine('\\record 1'), { type: 'record', row: 1 });
    assert.equal(parseSoqlMetaLine('\\open 0').type, 'invalid');
    assert.equal(parseSoqlMetaLine('\\record x').type, 'invalid');
    assert.equal(parseSoqlMetaLine('\\fields').type, 'invalid');
  });

  it('parses \\tooling with an optional mode', () => {
    assert.deepEqual(parseSoqlMetaLine('\\tooling'), { type: 'tooling', mode: undefined });
    assert.deepEqual(parseSoqlMetaLine('\\tooling on'), { type: 'tooling', mode: 'on' });
    assert.deepEqual(parseSoqlMetaLine('\\tooling off'), { type: 'tooling', mode: 'off' });
    assert.deepEqual(parseSoqlMetaLine('\\tooling auto'), { type: 'tooling', mode: 'auto' });
    assert.equal(parseSoqlMetaLine('\\tooling maybe').type, 'invalid');
  });

  it('rejects unknown commands', () => {
    assert.equal(parseSoqlMetaLine('\\nope').type, 'invalid');
  });
});

describe('applySoqlAutoLimit', () => {
  it('appends a LIMIT when the query has none', () => {
    assert.deepEqual(applySoqlAutoLimit('SELECT Id FROM Account', 2000), {
      soql: 'SELECT Id FROM Account LIMIT 2000',
      injectedLimit: 2000,
    });
  });

  it('leaves a query with an outer LIMIT alone', () => {
    const query = 'SELECT Id FROM Account LIMIT 5';
    assert.deepEqual(applySoqlAutoLimit(query, 2000), { soql: query });
  });

  it('is case-insensitive about the existing LIMIT', () => {
    const query = 'select id from account limit 5';
    assert.deepEqual(applySoqlAutoLimit(query, 2000), { soql: query });
  });

  it('still injects when only a subquery has a LIMIT', () => {
    const query = 'SELECT Id, (SELECT Id FROM Contacts LIMIT 1) FROM Account';
    assert.equal(applySoqlAutoLimit(query, 2000).soql, `${query} LIMIT 2000`);
  });

  it('ignores the word LIMIT inside a string literal', () => {
    const query = "SELECT Id FROM Account WHERE Name = 'no limit'";
    assert.equal(applySoqlAutoLimit(query, 2000).soql, `${query} LIMIT 2000`);
  });

  it('skips bare aggregate queries', () => {
    assert.deepEqual(applySoqlAutoLimit('SELECT COUNT() FROM Account', 2000), {
      soql: 'SELECT COUNT() FROM Account',
    });
    assert.deepEqual(applySoqlAutoLimit('SELECT COUNT(Id), MAX(CreatedDate) FROM Account', 2000), {
      soql: 'SELECT COUNT(Id), MAX(CreatedDate) FROM Account',
    });
  });

  it('injects for aggregates mixed with grouping fields', () => {
    const query = 'SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName';
    assert.equal(applySoqlAutoLimit(query, 2000).soql, `${query} LIMIT 2000`);
  });

  it('injects for an all-aggregate select list when a GROUP BY makes it multi-row', () => {
    const query = 'SELECT COUNT(Id) FROM Opportunity GROUP BY StageName';
    assert.equal(applySoqlAutoLimit(query, 2000).soql, `${query} LIMIT 2000`);
  });

  it('inserts before an outer OFFSET', () => {
    assert.equal(
      applySoqlAutoLimit('SELECT Id FROM Account OFFSET 10', 2000).soql,
      'SELECT Id FROM Account LIMIT 2000 OFFSET 10'
    );
  });

  it('inserts before FOR VIEW', () => {
    assert.equal(
      applySoqlAutoLimit('SELECT Id FROM Account FOR VIEW', 2000).soql,
      'SELECT Id FROM Account LIMIT 2000 FOR VIEW'
    );
  });

  it('does nothing when the limit is 0', () => {
    assert.deepEqual(applySoqlAutoLimit('SELECT Id FROM Account', 0), { soql: 'SELECT Id FROM Account' });
  });
});

describe('shapeSoqlRecords', () => {
  it('derives columns from the select list', () => {
    const shaped = shapeSoqlRecords('SELECT Id, Name FROM Account', [{ Id: '1', Name: 'Acme' }]);

    assert.deepEqual(shaped.fields, ['Id', 'Name']);
    assert.deepEqual(shaped.records, [{ Id: '1', Name: 'Acme' }]);
  });

  it('keeps dot-notation paths as columns', () => {
    const shaped = shapeSoqlRecords('SELECT Id, Owner.Name FROM Account', [{ Id: '1', Owner: { Name: 'Tom' } }]);

    assert.deepEqual(shaped.fields, ['Id', 'Owner.Name']);
  });

  it('re-aliases unaliased aggregate columns from the select list', () => {
    const shaped = shapeSoqlRecords('SELECT StageName, COUNT(Id), MAX(Amount) FROM Opportunity GROUP BY StageName', [
      { StageName: 'Won', expr0: 3, expr1: 100 },
    ]);

    assert.deepEqual(shaped.fields, ['StageName', 'COUNT(Id)', 'MAX(Amount)']);
    assert.deepEqual(shaped.records, [{ StageName: 'Won', 'COUNT(Id)': 3, 'MAX(Amount)': 100 }]);
  });

  it('uses the explicit alias when one is given', () => {
    const shaped = shapeSoqlRecords('SELECT COUNT(Id) total FROM Account', [{ total: 3 }]);

    assert.deepEqual(shaped.fields, ['total']);
    assert.deepEqual(shaped.records, [{ total: 3 }]);
  });

  it('names subquery columns after the relationship', () => {
    const shaped = shapeSoqlRecords('SELECT Id, (SELECT Id FROM Contacts) FROM Account', [
      { Id: '1', Contacts: { records: [] } },
    ]);

    assert.deepEqual(shaped.fields, ['Id', 'Contacts']);
  });

  it('falls back to record keys when the select list cannot be mapped', () => {
    const shaped = shapeSoqlRecords('SELECT FIELDS(STANDARD) FROM Account', [{ Id: '1', Name: 'Acme' }]);

    assert.deepEqual(shaped.fields, ['Id', 'Name']);
  });

  it('falls back to record keys when a derived column is missing from the records', () => {
    const shaped = shapeSoqlRecords('SELECT Id, Name FROM Account', [{ Id: '1', Other: 'x' }]);

    assert.deepEqual(shaped.fields, ['Id', 'Other']);
  });

  it('handles empty results using the select list', () => {
    const shaped = shapeSoqlRecords('SELECT Id, Name FROM Account', []);

    assert.deepEqual(shaped.fields, ['Id', 'Name']);
    assert.deepEqual(shaped.records, []);
  });
});

describe('endsInsideSoqlString', () => {
  it('detects an open string literal across lines', () => {
    assert.equal(endsInsideSoqlString("SELECT Id FROM Account WHERE Name = 'multi"), true);
    assert.equal(endsInsideSoqlString("SELECT Id FROM Account WHERE Name = 'done'"), false);
  });
});

describe('formatSoqlExecutionError', () => {
  it('positions the caret against the query as sent, after LIMIT injection', () => {
    const lines = formatSoqlExecutionError(
      'SELECT Id FROM Contact WHERE',
      2000,
      "unexpected token: 'LIMIT'\nERROR at Row:1:Column:30"
    );

    assert.equal(lines[0], 'SELECT Id FROM Contact WHERE LIMIT 2000');
    assert.equal(lines[1], `${' '.repeat(29)}^`);
  });
});

describe('formatSoqlQueryError', () => {
  it('draws a caret under the offending column', () => {
    const lines = formatSoqlQueryError(
      'SELECT Id FROM Acount',
      "sObject type 'Acount' is not supported.\nERROR at Row:1:Column:16"
    );

    assert.equal(lines[0], 'SELECT Id FROM Acount');
    assert.equal(lines[1], `${' '.repeat(15)}^`);
    assert.ok(lines[2].includes('Acount'));
  });

  it('passes through messages without a position', () => {
    assert.deepEqual(formatSoqlQueryError('SELECT Id FROM Account', 'expired access/refresh token'), [
      'expired access/refresh token',
    ]);
  });

  it('clamps the caret to the line length', () => {
    const lines = formatSoqlQueryError('SELECT', 'boom\nERROR at Row:1:Column:99');

    assert.equal(lines[1], `${' '.repeat(6)}^`);
  });
});

describe('appendSoqlHistory', () => {
  it('appends an entry', () => {
    assert.deepEqual(appendSoqlHistory(['a'], 'b'), ['a', 'b']);
  });

  it('skips consecutive duplicates', () => {
    assert.deepEqual(appendSoqlHistory(['a', 'b'], 'b'), ['a', 'b']);
    assert.deepEqual(appendSoqlHistory(['b', 'a'], 'b'), ['b', 'a', 'b']);
  });

  it('caps the history length, dropping the oldest entries', () => {
    const entries = Array.from({ length: 1000 }, (_, index) => `q${index}`);
    const appended = appendSoqlHistory(entries, 'newest');

    assert.equal(appended.length, 1000);
    assert.equal(appended[0], 'q1');
    assert.equal(appended[appended.length - 1], 'newest');
  });
});

describe('isBareCountQuery', () => {
  it('matches only a lone COUNT()', () => {
    assert.equal(isBareCountQuery('SELECT COUNT() FROM Account'), true);
    assert.equal(isBareCountQuery('select count( ) from account'), true);
    assert.equal(isBareCountQuery('SELECT COUNT(Id) FROM Account'), false);
    assert.equal(isBareCountQuery('SELECT Id FROM Account'), false);
  });
});

describe('renderSoqlTable', () => {
  const result = {
    fields: ['Id', 'Owner.Name'],
    records: [
      { Id: '1', Owner: { Name: 'Tom' } },
      { Id: '2', Owner: { Name: 'Ana' } },
    ],
  };

  it('adds a 1-based # column when asked', () => {
    const lines = renderSoqlTable(result, { indexColumn: true }).map(stripAnsi);

    assert.equal(lines[0], '#  Id  Owner.Name');
    assert.equal(lines[1], '1  1   Tom');
    assert.equal(lines[2], '2  2   Ana');
  });

  it('leaves the # column off by default and resolves dot paths', () => {
    const lines = renderSoqlTable(result).map(stripAnsi);

    assert.equal(lines[0], 'Id  Owner.Name');
    assert.equal(lines[1], '1   Tom');
  });
});

describe('buildSoqlFooter', () => {
  it('reports rows and duration', () => {
    assert.equal(
      buildSoqlFooter({ rowCount: 2, durationMs: 41, usedTooling: false, injectedLimitHit: false }),
      '2 rows · 41ms'
    );
    assert.equal(
      buildSoqlFooter({ rowCount: 1, durationMs: 5, usedTooling: false, injectedLimitHit: false }),
      '1 row · 5ms'
    );
  });

  it('notes a hit auto-limit and tooling routing', () => {
    assert.equal(
      buildSoqlFooter({
        rowCount: 2000,
        durationMs: 900,
        usedTooling: true,
        injectedLimit: 2000,
        injectedLimitHit: true,
      }),
      '2000 rows · 900ms · auto-limit 2000 hit · via Tooling API'
    );
  });
});

describe('splitCommandLine', () => {
  it('splits a command with arguments', () => {
    assert.deepEqual(splitCommandLine('less -SRFX'), { command: 'less', args: ['-SRFX'] });
  });

  it('returns undefined for blank input', () => {
    assert.equal(splitCommandLine(undefined), undefined);
    assert.equal(splitCommandLine('  '), undefined);
  });
});
