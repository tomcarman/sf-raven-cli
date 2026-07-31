import assert from 'node:assert/strict';
import chalk from 'chalk';
import { highlightSoql } from '../../src/shared/soqlHighlight.js';

describe('highlightSoql', () => {
  let savedLevel: 0 | 1 | 2 | 3;

  before(() => {
    savedLevel = chalk.level;
    chalk.level = 1;
  });

  after(() => {
    chalk.level = savedLevel;
  });

  it('colors keywords with the accent color', () => {
    assert.equal(
      highlightSoql('SELECT Id FROM Account'),
      `${chalk.cyan('SELECT')} Id ${chalk.cyan('FROM')} Account`
    );
  });

  it('colors string literals green, including unterminated ones', () => {
    assert.equal(
      highlightSoql("WHERE Name = 'Acme Inc'"),
      `${chalk.cyan('WHERE')} Name = ${chalk.green("'Acme Inc'")}`
    );
    assert.equal(highlightSoql("Name = 'Acme"), `Name = ${chalk.green("'Acme")}`);
  });

  it('keeps an escaped quote inside a string', () => {
    assert.equal(highlightSoql("'O\\'Brien'"), chalk.green("'O\\'Brien'"));
  });

  it('colors number and date literals', () => {
    assert.equal(highlightSoql('LIMIT 10'), `${chalk.cyan('LIMIT')} ${chalk.yellow('10')}`);
    assert.equal(
      highlightSoql('CreatedDate > 2026-07-31'),
      `CreatedDate > ${chalk.yellow('2026')}-${chalk.yellow('07')}-${chalk.yellow('31')}`
    );
    assert.equal(
      highlightSoql('CreatedDate = LAST_N_DAYS:30'),
      `CreatedDate = ${chalk.yellow('LAST_N_DAYS')}:${chalk.yellow('30')}`
    );
    assert.equal(highlightSoql('CreatedDate = TODAY'), `CreatedDate = ${chalk.yellow('TODAY')}`);
  });

  it('colors aggregate and date functions', () => {
    assert.equal(highlightSoql('COUNT(Id)'), `${chalk.magenta('COUNT')}(Id)`);
    assert.equal(
      highlightSoql('GROUP BY CALENDAR_YEAR(CreatedDate)'),
      `${chalk.cyan('GROUP')} ${chalk.cyan('BY')} ${chalk.magenta('CALENDAR_YEAR')}(CreatedDate)`
    );
  });

  it('leaves fields, objects, and operators unstyled', () => {
    assert.equal(highlightSoql('Owner.Profile.Name != Account_Type__c'), 'Owner.Profile.Name != Account_Type__c');
  });

  it('treats the line as string text while a previous line left one open', () => {
    assert.equal(
      highlightSoql("still text' AND Amount > 3", { openString: true }),
      `${chalk.green("still text'")} ${chalk.cyan('AND')} Amount > ${chalk.yellow('3')}`
    );
  });

  it('colors a line that stays entirely inside an open string', () => {
    assert.equal(highlightSoql('no closing quote here', { openString: true }), chalk.green('no closing quote here'));
  });

  it('returns the line unchanged when color support is off', () => {
    chalk.level = 0;

    try {
      assert.equal(highlightSoql("SELECT Id FROM Account WHERE Name = 'Acme' LIMIT 5"), "SELECT Id FROM Account WHERE Name = 'Acme' LIMIT 5");
    } finally {
      chalk.level = 1;
    }
  });
});
