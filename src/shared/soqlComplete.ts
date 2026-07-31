/**
 * Tab-completion engine for the SOQL REPL: a small tokenizer, a
 * cursor-context classifier, and a candidate builder over describe data. Pure
 * and synchronous - the describe source answers from what it has already
 * loaded and returns undefined for the rest, warming itself in the background
 * so the next Tab can do better.
 */

export type CompletionPicklistValue = { value: string; active: boolean };

export type CompletionField = {
  name: string;
  relationshipName?: string | null;
  referenceTo?: readonly string[] | null;
  picklistValues?: readonly CompletionPicklistValue[] | null;
};

export type CompletionChildRelationship = {
  relationshipName: string | null;
  childSObject: string;
};

export type CompletionObject = {
  name: string;
  fields: readonly CompletionField[];
  childRelationships: readonly CompletionChildRelationship[];
};

export type SoqlCompletionSource = {
  /** Merged object API names, or undefined while the global describes load. */
  globalObjectNames: () => readonly string[] | undefined;
  /** The object's describe if loaded; undefined kicks off a background fetch. */
  getObject: (name: string) => CompletionObject | undefined;
};

/** SOQL allows five levels of parent-relationship traversal in a field path. */
const relationshipDepthLimit = 5;

const soqlKeywords = [
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'ORDER BY',
  'GROUP BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'ASC',
  'DESC',
  'NULLS FIRST',
  'NULLS LAST',
  'FIRST',
  'LAST',
  'TRUE',
  'FALSE',
  'NULL',
] as const;

const soqlDateLiterals = ['TODAY', 'YESTERDAY', 'THIS_WEEK', 'THIS_MONTH', 'LAST_N_DAYS:'] as const;

const aggregateFunctions = ['AVG(', 'COUNT(', 'COUNT_DISTINCT(', 'MAX(', 'MIN(', 'SUM('] as const;

/** Fields every polymorphic reference exposes via the Name pseudo-object. */
const polymorphicNameFields = ['Id', 'Name', 'Type', 'FirstName', 'LastName', 'Title', 'Email', 'Phone', 'Alias'];

type ScanWord = { text: string; start: number; end: number; depth: number };
type ScanParen = { open: number; close?: number; depth: number };
type ScanString = { open: number; close?: number };
type ScanState = { words: ScanWord[]; parens: ScanParen[]; strings: ScanString[] };

const wordChar = /[A-Za-z0-9_]/;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A valid sObject API name - shared by meta-command parsing and the cache. */
export const sobjectNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Splits the input into word tokens tagged with their paren depth, plus the
 * paren pairs and string-literal spans themselves. Backslash escapes inside
 * literals are honoured, matching the REPL's balance scanner.
 */
const scan = (text: string): ScanState => {
  const words: ScanWord[] = [];
  const parens: ScanParen[] = [];
  const strings: ScanString[] = [];
  const openStack: ScanParen[] = [];
  let wordStart = -1;
  let literal: ScanString | undefined;

  const flushWord = (end: number): void => {
    if (wordStart !== -1) {
      words.push({ text: text.slice(wordStart, end), start: wordStart, end, depth: openStack.length });
      wordStart = -1;
    }
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (literal != null) {
      if (char === '\\') {
        index += 1;
      } else if (char === "'") {
        literal.close = index;
        literal = undefined;
      }

      continue;
    }

    if (char === "'") {
      flushWord(index);
      literal = { open: index };
      strings.push(literal);
    } else if (wordChar.test(char)) {
      if (wordStart === -1) {
        wordStart = index;
      }
    } else {
      flushWord(index);

      if (char === '(') {
        const paren = { open: index, depth: openStack.length + 1 };

        parens.push(paren);
        openStack.push(paren);
      } else if (char === ')') {
        const paren = openStack.pop();

        if (paren != null) {
          paren.close = index;
        }
      }
    }
  }

  flushWord(text.length);

  return { words, parens, strings };
};

/** The parens still open at the cursor, outermost first. */
const parenStackAt = (state: ScanState, cursor: number): ScanParen[] =>
  state.parens.filter((paren) => paren.open < cursor && (paren.close == null || paren.close >= cursor));

const stringAt = (state: ScanState, cursor: number): ScanString | undefined =>
  state.strings.find((literal) => literal.open < cursor && (literal.close == null || literal.close >= cursor));

/** A paren is a subquery when the first word directly inside it is SELECT. */
const isSubqueryParen = (state: ScanState, paren: ScanParen): boolean => {
  const first = state.words.find(
    (word) => word.start > paren.open && word.depth === paren.depth && (paren.close == null || word.end <= paren.close)
  );

  return first != null && first.text.toUpperCase() === 'SELECT';
};

/**
 * The words that belong to a query scope directly - inside its parens (or the
 * outer query) but not inside any nested paren.
 */
const scopeWords = (state: ScanState, scope: ScanParen | undefined, textLength: number): ScanWord[] => {
  const from = scope?.open ?? -1;
  const to = scope?.close ?? textLength;
  const depth = scope?.depth ?? 0;

  return state.words.filter((word) => word.start > from && word.end <= to && word.depth === depth);
};

/** The word following the scope's FROM keyword, if both are present. */
const fromWordOf = (words: readonly ScanWord[]): string | undefined => {
  const index = words.findIndex((word) => word.text.toUpperCase() === 'FROM');

  return index === -1 ? undefined : words[index + 1]?.text;
};

/**
 * A select-list subquery queries a child relationship of its parent; a
 * subquery anywhere else (an IN/NOT IN semi-join) queries an object directly.
 */
const isChildSubquery = (state: ScanState, scope: ScanParen, parent: ScanParen | undefined, full: string): boolean => {
  const preceding = scopeWords(state, parent, full.length).filter((word) => word.end <= scope.open);
  const clause = lastClauseWord(preceding);

  return clause?.text.toUpperCase() === 'SELECT';
};

/**
 * How to reach the scope's queried object: element 0 is an object API name,
 * later elements are child-relationship names walked inward through
 * select-list subqueries. Undefined when any FROM along the way is missing.
 */
const chainForScope = (
  state: ScanState,
  subqueryStack: readonly ScanParen[],
  scopeIndex: number,
  full: string
): string[] | undefined => {
  const scope = scopeIndex === -1 ? undefined : subqueryStack[scopeIndex];
  const from = fromWordOf(scopeWords(state, scope, full.length));

  if (from == null) {
    return undefined;
  }

  if (scope == null || !isChildSubquery(state, scope, subqueryStack[scopeIndex - 1], full)) {
    return [from];
  }

  const parent = chainForScope(state, subqueryStack, scopeIndex - 1, full);

  return parent == null ? undefined : [...parent, from];
};

const clauseWords = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP',
  'ORDER',
  'BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'WITH',
  'USING',
  'TYPEOF',
]);

const lastClauseWord = (words: readonly ScanWord[]): { text: string; index: number } | undefined => {
  for (let index = words.length - 1; index >= 0; index--) {
    if (clauseWords.has(words[index].text.toUpperCase())) {
      return { text: words[index].text, index };
    }
  }

  return undefined;
};

type Fragment = {
  /** The trailing word being completed - what readline will replace. */
  fragment: string;
  /** Dotted segments before the fragment (`Owner.Profile.Na` -> [Owner, Profile]). */
  path: string[];
  /** Where the whole dotted token starts; clause detection looks before this. */
  tokenStart: number;
};

const fragmentAt = (before: string): Fragment => {
  let start = before.length;

  while (start > 0 && wordChar.test(before[start - 1])) {
    start -= 1;
  }

  const fragment = before.slice(start);
  const path: string[] = [];
  let tokenStart = start;

  while (before[tokenStart - 1] === '.') {
    let segmentStart = tokenStart - 1;

    while (segmentStart > 0 && wordChar.test(before[segmentStart - 1])) {
      segmentStart -= 1;
    }

    const segment = before.slice(segmentStart, tokenStart - 1);

    if (!identifierPattern.test(segment)) {
      break;
    }

    path.unshift(segment);
    tokenStart = segmentStart;
  }

  return { fragment, path, tokenStart };
};

export type SoqlFieldClause = 'select' | 'where' | 'groupby' | 'orderby' | 'having';

export type SoqlCompletionContext =
  | { kind: 'keyword'; fragment: string }
  | { kind: 'by'; fragment: string }
  | { kind: 'object'; fragment: string }
  | { kind: 'childRelationship'; fragment: string; parentChain?: string[] }
  | {
      kind: 'field';
      fragment: string;
      chain?: string[];
      path: string[];
      clause: SoqlFieldClause;
      insideFunction?: boolean;
    }
  | { kind: 'picklist'; fragment: string; chain?: string[]; path: string[]; quoted: boolean; inList: boolean }
  | { kind: 'none'; fragment: string };

/** The dotted field path ending just before `end`, or undefined. */
const fieldPathEndingAt = (before: string, end: number): string[] | undefined => {
  let cursor = end;

  while (cursor > 0 && /\s/.test(before[cursor - 1])) {
    cursor -= 1;
  }

  const segments: string[] = [];

  for (;;) {
    let start = cursor;

    while (start > 0 && wordChar.test(before[start - 1])) {
      start -= 1;
    }

    const segment = before.slice(start, cursor);

    if (!identifierPattern.test(segment)) {
      return undefined;
    }

    segments.unshift(segment);

    if (before[start - 1] !== '.') {
      return segments;
    }

    cursor = start - 1;
  }
};

const comparisonWords = new Set(['LIKE', 'IN', 'INCLUDES', 'EXCLUDES']);

/**
 * Looks just before `probe` (the opening quote, or the fragment being typed)
 * for a comparison operator or an IN/INCLUDES/EXCLUDES value list, and
 * resolves the field path being compared. Undefined when the position is not
 * a comparison value.
 */
const comparisonTarget = (
  before: string,
  state: ScanState,
  probe: number
): { path: string[]; inList: boolean } | undefined => {
  let index = probe - 1;

  while (index >= 0 && /\s/.test(before[index])) {
    index -= 1;
  }

  if (index < 0) {
    return undefined;
  }

  const char = before[index];

  if (char === ',' || char === '(') {
    const paren = parenStackAt(state, index + 1).pop();

    if (paren == null || isSubqueryParen(state, paren)) {
      return undefined;
    }

    const keyword = state.words.filter((word) => word.end <= paren.open).pop();

    if (keyword == null || !comparisonWords.has(keyword.text.toUpperCase())) {
      return undefined;
    }

    const path = fieldPathEndingAt(before, keyword.start);

    return path == null ? undefined : { path, inList: true };
  }

  let operatorStart: number | undefined;

  if (index > 0 && ['<=', '>=', '!=', '<>'].includes(before.slice(index - 1, index + 1))) {
    operatorStart = index - 1;
  } else if (['=', '<', '>'].includes(char)) {
    operatorStart = index;
  } else {
    const word = state.words.filter((entry) => entry.end === index + 1).pop();

    if (word != null && word.text.toUpperCase() === 'LIKE') {
      operatorStart = word.start;
    }
  }

  if (operatorStart == null) {
    return undefined;
  }

  const path = fieldPathEndingAt(before, operatorStart);

  return path == null ? undefined : { path, inList: false };
};

/** Everything the per-clause classifiers need about the cursor position. */
type CursorSite = {
  before: string;
  full: string;
  state: ScanState;
  subqueryStack: ScanParen[];
  scopeIndex: number;
  fragment: string;
  path: string[];
  tokenStart: number;
  preceding: ScanWord[];
};

const siteChain = (site: CursorSite): string[] | undefined =>
  chainForScope(site.state, site.subqueryStack, site.scopeIndex, site.full);

const fromClauseContext = (site: CursorSite, clauseIndex: number): SoqlCompletionContext => {
  if (site.preceding.length > clauseIndex + 1) {
    return { kind: 'keyword', fragment: site.fragment };
  }

  const scope = site.subqueryStack[site.scopeIndex];

  if (scope != null && isChildSubquery(site.state, scope, site.subqueryStack[site.scopeIndex - 1], site.full)) {
    return {
      kind: 'childRelationship',
      fragment: site.fragment,
      parentChain: chainForScope(site.state, site.subqueryStack, site.scopeIndex - 1, site.full),
    };
  }

  return { kind: 'object', fragment: site.fragment };
};

const conditionClauseContext = (site: CursorSite, clause: 'where' | 'having'): SoqlCompletionContext => {
  const target = site.path.length === 0 ? comparisonTarget(site.before, site.state, site.tokenStart) : undefined;

  if (target != null) {
    return {
      kind: 'picklist',
      fragment: site.fragment,
      chain: siteChain(site),
      path: target.path,
      quoted: false,
      inList: target.inList,
    };
  }

  return { kind: 'field', fragment: site.fragment, chain: siteChain(site), path: site.path, clause };
};

const byClauseContext = (site: CursorSite, clauseIndex: number): SoqlCompletionContext => {
  const opener = site.preceding[clauseIndex - 1]?.text.toUpperCase();

  if (opener === 'ORDER' || opener === 'GROUP') {
    return {
      kind: 'field',
      fragment: site.fragment,
      chain: siteChain(site),
      path: site.path,
      clause: opener === 'ORDER' ? 'orderby' : 'groupby',
    };
  }

  return { kind: 'keyword', fragment: site.fragment };
};

const clauseContext = (site: CursorSite, insideFunction: boolean): SoqlCompletionContext => {
  const clause = lastClauseWord(site.preceding);

  if (clause == null) {
    return { kind: 'keyword', fragment: site.fragment };
  }

  switch (clause.text.toUpperCase()) {
    case 'SELECT':
      return {
        kind: 'field',
        fragment: site.fragment,
        chain: siteChain(site),
        path: site.path,
        clause: 'select',
        insideFunction,
      };
    case 'FROM':
      return fromClauseContext(site, clause.index);
    case 'WHERE':
      return conditionClauseContext(site, 'where');
    case 'HAVING':
      return conditionClauseContext(site, 'having');
    case 'GROUP':
    case 'ORDER':
      return { kind: 'by', fragment: site.fragment };
    case 'BY':
      return byClauseContext(site, clause.index);
    default:
      return { kind: 'none', fragment: site.fragment };
  }
};

/**
 * Classifies what the cursor position is asking for. `before` is the input up
 * to the cursor (prior REPL lines joined with the readline line so far);
 * `full` additionally includes the rest of the current line, so a FROM typed
 * after the cursor still names the object being completed.
 */
export const classifySoqlContext = (before: string, full: string): SoqlCompletionContext => {
  const state = scan(full);
  const cursor = before.length;
  const stack = parenStackAt(state, cursor);
  const subqueryStack = stack.filter((paren) => isSubqueryParen(state, paren));
  const scopeIndex = subqueryStack.length - 1;
  const scope = scopeIndex === -1 ? undefined : subqueryStack[scopeIndex];
  const literal = stringAt(state, cursor);

  if (literal != null) {
    const target = comparisonTarget(before, state, literal.open);
    const fragment = before.slice(literal.open + 1);

    return target == null
      ? { kind: 'none', fragment: '' }
      : {
          kind: 'picklist',
          fragment,
          chain: chainForScope(state, subqueryStack, scopeIndex, full),
          path: target.path,
          quoted: true,
          inList: target.inList,
        };
  }

  const { fragment, path, tokenStart } = fragmentAt(before);
  const preceding = scopeWords(state, scope, full.length).filter((word) => word.end <= tokenStart);

  // Inside a function call's parens (COUNT(, FORMAT(, ...) only fields fit.
  const insideFunction = stack.length > 0 && stack[stack.length - 1] !== scope;

  return clauseContext(
    { before, full, state, subqueryStack, scopeIndex, fragment, path, tokenStart, preceding },
    insideFunction
  );
};

const findCaseInsensitive = <T>(
  entries: readonly T[],
  name: string,
  of: (entry: T) => string | null | undefined
): T | undefined => entries.find((entry) => of(entry)?.toLowerCase() === name.toLowerCase());

/** Walks child-relationship names down to the describe of the queried object. */
const resolveChain = (source: SoqlCompletionSource, chain: readonly string[]): CompletionObject | undefined => {
  let object = source.getObject(chain[0]);

  for (const relationship of chain.slice(1)) {
    if (object == null) {
      return undefined;
    }

    const child = findCaseInsensitive(object.childRelationships, relationship, (entry) => entry.relationshipName);

    object = child == null ? undefined : source.getObject(child.childSObject);
  }

  return object;
};

/**
 * Follows a dotted parent-relationship path. A polymorphic reference resolves
 * to the Name pseudo-object's fields merged with a likely concrete target
 * (User when referenced, else the first), so `What.` and `Owner.` both offer
 * something useful.
 */
const resolvePath = (
  source: SoqlCompletionSource,
  start: CompletionObject,
  path: readonly string[]
): CompletionObject | undefined => {
  if (path.length > relationshipDepthLimit) {
    return undefined;
  }

  let object: CompletionObject | undefined = start;

  for (const segment of path) {
    if (object == null) {
      return undefined;
    }

    const field: CompletionField | undefined = findCaseInsensitive(
      object.fields,
      segment,
      (entry) => entry.relationshipName
    );
    const targets = field?.referenceTo ?? [];

    if (field == null || targets.length === 0) {
      return undefined;
    }

    if (targets.length === 1) {
      object = source.getObject(targets[0]);
      continue;
    }

    const concrete = source.getObject(targets.includes('User') ? 'User' : targets[0]);

    object = {
      name: 'Name',
      fields: [...polymorphicNameFields.map((name) => ({ name })), ...(concrete?.fields ?? [])],
      childRelationships: [],
    };
  }

  return object;
};

/** Field names plus relationship names (so `Owner` completes alongside `OwnerId`). */
const fieldCandidates = (object: CompletionObject): string[] => {
  const names: string[] = [];

  for (const field of object.fields) {
    names.push(field.name);

    if (field.relationshipName != null && field.relationshipName !== '') {
      names.push(field.relationshipName);
    }
  }

  return names.sort((a, b) => a.localeCompare(b));
};

const picklistCandidates = (
  source: SoqlCompletionSource,
  context: Extract<SoqlCompletionContext, { kind: 'picklist' }>
): string[] => {
  const object = context.chain == null ? undefined : resolveChain(source, context.chain);
  const holder = object == null ? undefined : resolvePath(source, object, context.path.slice(0, -1));
  const field =
    holder == null
      ? undefined
      : findCaseInsensitive(holder.fields, context.path[context.path.length - 1], (entry) => entry.name);
  const values = (field?.picklistValues ?? []).filter((value) => value.active).map((value) => value.value);

  if (context.quoted) {
    return values.map((value) => `${value}'`);
  }

  // Unquoted position: quoted values plus the literals that are also legal
  // here (and SELECT, when an IN list could instead open a semi-join).
  return [
    ...values.map((value) => `'${value}'`),
    ...(context.inList ? ['SELECT'] : []),
    'TRUE',
    'FALSE',
    'NULL',
    ...soqlDateLiterals,
  ];
};

const fieldContextCandidates = (
  source: SoqlCompletionSource,
  context: Extract<SoqlCompletionContext, { kind: 'field' }>
): string[] => {
  const object = context.chain == null ? undefined : resolveChain(source, context.chain);
  const resolved = object == null ? undefined : resolvePath(source, object, context.path);
  const fields = resolved == null ? [] : fieldCandidates(resolved);

  // After a dot or inside a select-list function call only fields make
  // sense; elsewhere the keywords that could follow stay on offer even while
  // describes are still loading.
  if (context.path.length > 0 || context.insideFunction === true) {
    return fields;
  }

  switch (context.clause) {
    case 'select':
      return [...fields, ...aggregateFunctions, ...soqlKeywords];
    case 'where':
    case 'having':
      return [...fields, ...soqlKeywords, ...soqlDateLiterals];
    default:
      return [...fields, ...soqlKeywords];
  }
};

const candidatesFor = (source: SoqlCompletionSource, context: SoqlCompletionContext): string[] => {
  switch (context.kind) {
    case 'keyword':
      return [...soqlKeywords, ...soqlDateLiterals];
    case 'by':
      return ['BY'];
    case 'object':
      return [...(source.globalObjectNames() ?? [])];
    case 'childRelationship': {
      const parent = context.parentChain == null ? undefined : resolveChain(source, context.parentChain);

      return (parent?.childRelationships ?? [])
        .map((entry) => entry.relationshipName)
        .filter((name): name is string => name != null && name !== '')
        .sort((a, b) => a.localeCompare(b));
    }
    case 'field':
      return fieldContextCandidates(source, context);
    case 'picklist':
      return picklistCandidates(source, context);
    case 'none':
      return [];
  }
};

/**
 * The readline completer contract: candidates matching the fragment, plus the
 * fragment itself so readline knows what it is replacing. Matching is
 * case-insensitive; candidates keep their canonical casing (keywords upper,
 * fields as described) and readline re-cases the typed prefix to fit.
 */
export const completeSoql = (before: string, full: string, source: SoqlCompletionSource): [string[], string] => {
  const context = classifySoqlContext(before, full);
  const fragment = 'fragment' in context ? context.fragment : '';
  const lower = fragment.toLowerCase();
  const seen = new Set<string>();
  const matches: string[] = [];

  for (const candidate of candidatesFor(source, context)) {
    if (candidate.toLowerCase().startsWith(lower) && !seen.has(candidate)) {
      seen.add(candidate);
      matches.push(candidate);
    }
  }

  return [matches, fragment];
};

/** The object named by the outer query's FROM clause, if one is present. */
export const outerSoqlFromObject = (query: string): string | undefined => {
  const state = scan(query);

  return fromWordOf(state.words.filter((word) => word.depth === 0));
};
