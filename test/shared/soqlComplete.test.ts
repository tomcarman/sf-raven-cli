import assert from 'node:assert/strict';
import {
  classifySoqlContext,
  completeSoql,
  outerSoqlFromObject,
  type CompletionObject,
  type SoqlCompletionSource,
} from '../../src/shared/soqlComplete.js';

const account: CompletionObject = {
  name: 'Account',
  fields: [
    { name: 'Id' },
    { name: 'Name' },
    { name: 'AnnualRevenue' },
    {
      name: 'Industry',
      picklistValues: [
        { value: 'Agriculture', active: true },
        { value: 'Banking', active: true },
        { value: 'Legacy Industry', active: false },
      ],
    },
    { name: 'OwnerId', relationshipName: 'Owner', referenceTo: ['User'] },
  ],
  childRelationships: [
    { relationshipName: 'Contacts', childSObject: 'Contact' },
    { relationshipName: 'Cases', childSObject: 'Case' },
    { relationshipName: null, childSObject: 'AccountFeed' },
  ],
};

const contact: CompletionObject = {
  name: 'Contact',
  fields: [
    { name: 'Id' },
    { name: 'LastName' },
    { name: 'Email' },
    { name: 'AccountId', relationshipName: 'Account', referenceTo: ['Account'] },
  ],
  childRelationships: [],
};

const user: CompletionObject = {
  name: 'User',
  fields: [
    { name: 'Id' },
    { name: 'Username' },
    { name: 'ProfileId', relationshipName: 'Profile', referenceTo: ['Profile'] },
  ],
  childRelationships: [],
};

const profile: CompletionObject = {
  name: 'Profile',
  fields: [{ name: 'Id' }, { name: 'Name' }],
  childRelationships: [],
};

const task: CompletionObject = {
  name: 'Task',
  fields: [
    { name: 'Id' },
    { name: 'Subject' },
    { name: 'WhatId', relationshipName: 'What', referenceTo: ['Account', 'Opportunity'] },
  ],
  childRelationships: [],
};

const objects = new Map([account, contact, user, profile, task].map((object) => [object.name.toLowerCase(), object]));

const source: SoqlCompletionSource = {
  globalObjectNames: () => ['Account', 'ApexClass', 'Case', 'Contact', 'Profile', 'Task', 'User'],
  getObject: (name) => objects.get(name.toLowerCase()),
};

/** A source that has nothing loaded yet - the cold-cache behavior. */
const coldSource: SoqlCompletionSource = {
  globalObjectNames: () => undefined,
  getObject: () => undefined,
};

/** Completes with the cursor at the end of `text`. */
const complete = (text: string, from: SoqlCompletionSource = source): string[] => completeSoql(text, text, from)[0];

describe('completeSoql', () => {
  describe('keyword contexts', () => {
    it('offers SELECT and keywords at the start of input', () => {
      const [candidates, fragment] = completeSoql('', '', source);

      assert.ok(candidates.includes('SELECT'));
      assert.ok(candidates.includes('FROM'));
      assert.equal(fragment, '');
    });

    it('matches keywords case-insensitively and completes them uppercase', () => {
      assert.deepEqual(complete('sel'), ['SELECT']);
    });

    it('offers keywords in the select list when no FROM exists yet', () => {
      const candidates = complete('SELECT Id, ');

      assert.ok(candidates.includes('FROM'));
      assert.ok(candidates.includes('COUNT('));
    });

    it('offers keywords after the FROM object is already named', () => {
      const candidates = complete('SELECT Id FROM Account ');

      assert.ok(candidates.includes('WHERE'));
      assert.ok(candidates.includes('ORDER BY'));
      assert.ok(candidates.includes('LIMIT'));
    });

    it('completes BY after ORDER and GROUP', () => {
      assert.deepEqual(complete('SELECT Id FROM Account ORDER '), ['BY']);
      assert.deepEqual(complete('SELECT Id FROM Account GROUP B'), ['BY']);
    });

    it('offers nothing after LIMIT', () => {
      assert.deepEqual(complete('SELECT Id FROM Account LIMIT '), []);
    });
  });

  describe('object completion after FROM', () => {
    it('offers global object names', () => {
      assert.deepEqual(complete('SELECT Id FROM A'), ['Account', 'ApexClass']);
    });

    it('offers every object when nothing is typed yet', () => {
      assert.equal(complete('SELECT Id FROM ').length, 7);
    });

    it('offers no objects while the global describes are loading', () => {
      assert.deepEqual(complete('SELECT Id FROM A', coldSource), []);
    });
  });

  describe('field completion', () => {
    it('completes fields of the FROM object in the select list', () => {
      const [candidates, fragment] = completeSoql('SELECT Na', 'SELECT Na FROM Account', source);

      assert.deepEqual(candidates, ['Name']);
      assert.equal(fragment, 'Na');
    });

    it('scans the rest of the line for FROM, dissolving SELECT-before-FROM', () => {
      const [candidates] = completeSoql('SELECT ', 'SELECT  FROM Account', source);

      assert.ok(candidates.includes('Name'));
      assert.ok(candidates.includes('Industry'));
      assert.ok(candidates.includes('Owner'));
      assert.ok(candidates.includes('OwnerId'));
    });

    it('offers aggregate functions in select-list position', () => {
      const [candidates] = completeSoql('SELECT COUNT_', 'SELECT COUNT_ FROM Account', source);

      assert.deepEqual(candidates, ['COUNT_DISTINCT(']);
    });

    it('completes fields inside an aggregate call', () => {
      const [candidates] = completeSoql('SELECT COUNT(An', 'SELECT COUNT(An) FROM Account', source);

      assert.deepEqual(candidates, ['AnnualRevenue']);
    });

    it('completes fields after WHERE', () => {
      assert.deepEqual(complete('SELECT Id FROM Account WHERE Ind'), ['Industry']);
    });

    it('completes fields inside grouping parens in WHERE', () => {
      assert.deepEqual(complete("SELECT Id FROM Account WHERE (Name = 'x' OR Ind"), ['Industry']);
    });

    it('completes fields after ORDER BY, GROUP BY, and HAVING', () => {
      assert.deepEqual(complete('SELECT Id FROM Account ORDER BY Na'), ['Name']);
      assert.deepEqual(complete('SELECT Industry FROM Account GROUP BY Ind'), ['Industry']);
      assert.deepEqual(complete('SELECT Industry FROM Account GROUP BY Industry HAVING Ind'), ['Industry']);
    });

    it('keeps keywords on offer while the object describe is still loading', () => {
      const warming: SoqlCompletionSource = {
        globalObjectNames: () => ['Account'],
        getObject: () => undefined,
      };

      assert.deepEqual(complete('SELECT Id FROM Account WHERE Ind', warming), []);
      assert.ok(complete('SELECT Id FROM Account WHERE ', warming).includes('AND'));
    });

    it('ignores SOQL keywords inside string literals', () => {
      assert.deepEqual(complete("SELECT Id FROM Account WHERE Name = 'FROM Fake' AND Ind"), ['Industry']);
    });

    it('completes fields with describe casing from a lowercase prefix', () => {
      assert.deepEqual(complete('SELECT Id FROM Account WHERE annualrev'), ['AnnualRevenue']);
    });
  });

  describe('dot-chain completion', () => {
    it('completes fields of a parent relationship', () => {
      const [candidates, fragment] = completeSoql('SELECT Owner.Prof', 'SELECT Owner.Prof FROM Account', source);

      assert.deepEqual(candidates, ['Profile', 'ProfileId']);
      assert.equal(fragment, 'Prof');
    });

    it('recurses through multiple relationship levels', () => {
      assert.deepEqual(complete('SELECT Id FROM Account WHERE Owner.Profile.Na'), ['Name']);
    });

    it('offers no keywords after a dot', () => {
      const [candidates] = completeSoql('SELECT Owner.', 'SELECT Owner. FROM Account', source);

      assert.ok(candidates.length > 0);
      assert.ok(!candidates.includes('FROM'));
    });

    it('stops at the five-level relationship limit', () => {
      const chain = 'Account.Owner.Profile.Owner.Profile.Owner.';

      assert.deepEqual(complete(`SELECT Id FROM Contact WHERE ${chain}`), []);
    });

    it('completes Name pseudo-object fields for polymorphic references', () => {
      const [candidates] = completeSoql('SELECT What.Ty', 'SELECT What.Ty FROM Task', source);

      assert.deepEqual(candidates, ['Type']);
    });

    it('merges a concrete target into polymorphic completion', () => {
      const [candidates] = completeSoql('SELECT What.Annual', 'SELECT What.Annual FROM Task', source);

      assert.deepEqual(candidates, ['AnnualRevenue']);
    });

    it('returns nothing for an unknown relationship', () => {
      assert.deepEqual(complete('SELECT Id FROM Account WHERE Bogus.Na'), []);
    });
  });

  describe('picklist value completion', () => {
    it('offers active values inside an opened string after a comparison', () => {
      const [candidates, fragment] = completeSoql(
        "SELECT Id FROM Account WHERE Industry = '",
        "SELECT Id FROM Account WHERE Industry = '",
        source
      );

      assert.deepEqual(candidates, ["Agriculture'", "Banking'"]);
      assert.equal(fragment, '');
    });

    it('filters values by the typed prefix inside the quote', () => {
      const [candidates, fragment] = completeSoql(
        "SELECT Id FROM Account WHERE Industry = 'Ag",
        "SELECT Id FROM Account WHERE Industry = 'Ag",
        source
      );

      assert.deepEqual(candidates, ["Agriculture'"]);
      assert.equal(fragment, 'Ag');
    });

    it('offers quoted values right after the operator, before any quote', () => {
      const candidates = complete('SELECT Id FROM Account WHERE Industry = ');

      assert.ok(candidates.includes("'Agriculture'"));
      assert.ok(candidates.includes("'Banking'"));
      assert.ok(candidates.includes('TODAY'));
    });

    it('excludes inactive values', () => {
      assert.ok(!complete("SELECT Id FROM Account WHERE Industry = '").some((value) => value.startsWith('Legacy')));
    });

    it('completes values inside an IN list', () => {
      const [candidates] = completeSoql(
        "SELECT Id FROM Account WHERE Industry IN ('Agriculture', 'B",
        "SELECT Id FROM Account WHERE Industry IN ('Agriculture', 'B",
        source
      );

      assert.deepEqual(candidates, ["Banking'"]);
    });

    it('resolves the picklist through a dotted field path', () => {
      const [candidates] = completeSoql(
        "SELECT Id FROM Contact WHERE Account.Industry = 'Ban",
        "SELECT Id FROM Contact WHERE Account.Industry = 'Ban",
        source
      );

      assert.deepEqual(candidates, ["Banking'"]);
    });

    it('offers nothing inside a string on a non-picklist field', () => {
      assert.deepEqual(complete("SELECT Id FROM Account WHERE Name = 'Ac"), []);
    });

    it('offers nothing inside a string that is not a comparison value', () => {
      assert.deepEqual(complete("SELECT Id FROM Account WHERE 'stray"), []);
    });
  });

  describe('subqueries', () => {
    it('completes child relationship names after FROM in a select-list subquery', () => {
      const before = 'SELECT Id, (SELECT Id FROM ';
      const [candidates] = completeSoql(before, `${before}) FROM Account`, source);

      assert.deepEqual(candidates, ['Cases', 'Contacts']);
    });

    it('filters child relationships by prefix', () => {
      const before = 'SELECT Id, (SELECT Id FROM Con';
      const [candidates, fragment] = completeSoql(before, `${before}) FROM Account`, source);

      assert.deepEqual(candidates, ['Contacts']);
      assert.equal(fragment, 'Con');
    });

    it('completes the child object fields inside the subquery select list', () => {
      const before = 'SELECT Id, (SELECT La';
      const [candidates] = completeSoql(before, `${before} FROM Contacts) FROM Account`, source);

      assert.deepEqual(candidates, ['LastName']);
    });

    it('completes object names after FROM in an IN semi-join', () => {
      const before = 'SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Con';
      const [candidates] = completeSoql(before, `${before})`, source);

      assert.deepEqual(candidates, ['Contact']);
    });

    it('completes the semi-join object fields in its select list', () => {
      const before = 'SELECT Id FROM Account WHERE Id IN (SELECT Acc';
      const [candidates] = completeSoql(before, `${before} FROM Contact)`, source);

      assert.deepEqual(candidates, ['Account', 'AccountId']);
    });

    it('keeps outer-query completion working after a closed subquery', () => {
      assert.deepEqual(complete('SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE Ind'), ['Industry']);
    });
  });

  describe('malformed and hostile input', () => {
    it('survives unbalanced parens', () => {
      assert.deepEqual(complete('SELECT Id FROM Account WHERE ((((Ind'), ['Industry']);
    });

    it('survives stray closing parens', () => {
      assert.ok(Array.isArray(complete(') ) SELECT ')));
    });

    it('survives an escaped quote inside a literal', () => {
      assert.deepEqual(complete("SELECT Id FROM Account WHERE Name = 'O\\'Brien' AND Ind"), ['Industry']);
    });

    it('treats an unknown FROM object as having no fields', () => {
      assert.deepEqual(complete('SELECT Id FROM Bogus WHERE Xy'), []);
    });
  });

  describe('multi-line input', () => {
    it('classifies across newlines from earlier REPL lines', () => {
      const before = 'SELECT Id,\n  Na';
      const [candidates] = completeSoql(before, `${before}\nFROM Account`, source);

      assert.deepEqual(candidates, ['Name']);
    });
  });
});

describe('classifySoqlContext', () => {
  it('distinguishes child subqueries from semi-joins', () => {
    const child = classifySoqlContext('SELECT Id, (SELECT Id FROM ', 'SELECT Id, (SELECT Id FROM ) FROM Account');
    const semi = classifySoqlContext(
      'SELECT Id FROM Account WHERE Id IN (SELECT Id FROM ',
      'SELECT Id FROM Account WHERE Id IN (SELECT Id FROM )'
    );

    assert.equal(child.kind, 'childRelationship');
    assert.equal(semi.kind, 'object');
  });

  it('reports the dotted path separately from the fragment', () => {
    const context = classifySoqlContext('SELECT Owner.Profile.Na', 'SELECT Owner.Profile.Na FROM Account');

    assert.deepEqual(context, {
      kind: 'field',
      fragment: 'Na',
      chain: ['Account'],
      path: ['Owner', 'Profile'],
      clause: 'select',
      grouped: false,
    });
  });
});

describe('outerSoqlFromObject', () => {
  it('finds the outer FROM object', () => {
    assert.equal(outerSoqlFromObject('SELECT Id FROM Account WHERE Id != null'), 'Account');
  });

  it('ignores subquery FROMs', () => {
    assert.equal(outerSoqlFromObject('SELECT Id, (SELECT Id FROM Contacts) FROM Account'), 'Account');
  });

  it('ignores FROM inside string literals', () => {
    assert.equal(outerSoqlFromObject("SELECT Id FROM Account WHERE Name = 'FROM Fake'"), 'Account');
  });

  it('returns undefined when there is no FROM', () => {
    assert.equal(outerSoqlFromObject('SELECT Id'), undefined);
  });
});
