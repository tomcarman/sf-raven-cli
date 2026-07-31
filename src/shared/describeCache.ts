import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CompletionObject, SoqlCompletionSource } from './soqlComplete.js';

/**
 * Describe data for SOQL completion, cached in memory for the session and on
 * disk across sessions. Everything is best-effort: a fetch or disk failure
 * costs candidates, never the REPL.
 */

export const describeCacheTtlMs = 24 * 60 * 60 * 1000;

/** Disk layout is per org and API version, so upgrades never serve stale shapes. */
export const describeCacheDirectory = (cacheDir: string, orgId: string, apiVersion: string): string =>
  join(cacheDir, 'raven', 'describes', orgId, apiVersion);

type GlobalEntry = { name: string; queryable?: boolean };

/** The subset of a raw describe result that completion consumes. */
type RawObjectDescribe = {
  name: string;
  fields?: Array<{
    name: string;
    relationshipName?: string | null;
    referenceTo?: string[] | null;
    picklistValues?: Array<{ value: string; active: boolean }> | null;
  }> | null;
  childRelationships?: Array<{ relationshipName?: string | null; childSObject: string }> | null;
};

export type DescribeClient = {
  describeGlobal: () => Promise<{ sobjects: GlobalEntry[] }>;
  describeSObject: (name: string) => Promise<RawObjectDescribe>;
};

/** The describe surface of a jsforce Connection that the cache consumes. */
export type DescribeCapableConnection = {
  describeGlobal: () => Promise<{ sobjects: GlobalEntry[] }>;
  describe: (name: string) => Promise<RawObjectDescribe>;
  tooling: {
    describeGlobal: () => Promise<{ sobjects: GlobalEntry[] }>;
    describe: (name: string) => Promise<RawObjectDescribe>;
  };
};

export const describeClients = (
  connection: DescribeCapableConnection
): { regular: DescribeClient; tooling: DescribeClient } => ({
  regular: {
    describeGlobal: () => connection.describeGlobal(),
    describeSObject: (name) => connection.describe(name),
  },
  tooling: {
    describeGlobal: () => connection.tooling.describeGlobal(),
    describeSObject: (name) => connection.tooling.describe(name),
  },
});

type Source = 'regular' | 'tooling';

type Envelope<T> = { fetchedAt: number; data: T };

/** Raw describes are megabytes; only what completion reads goes to disk. */
const slimObject = (raw: RawObjectDescribe): CompletionObject => ({
  name: raw.name,
  fields: (raw.fields ?? []).map((field) => ({
    name: field.name,
    ...(field.relationshipName == null ? {} : { relationshipName: field.relationshipName }),
    ...(field.referenceTo == null || field.referenceTo.length === 0 ? {} : { referenceTo: field.referenceTo }),
    ...(field.picklistValues == null || field.picklistValues.length === 0
      ? {}
      : { picklistValues: field.picklistValues.map(({ value, active }) => ({ value, active })) }),
  })),
  childRelationships: (raw.childRelationships ?? [])
    .filter((entry) => entry.relationshipName != null && entry.relationshipName !== '')
    .map((entry) => ({ relationshipName: entry.relationshipName as string, childSObject: entry.childSObject })),
});

/** Object names become cache file names, so anything unusual stays uncached. */
const safeNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/;

export type DescribeCacheOptions = {
  directory: string;
  regular: DescribeClient;
  tooling: DescribeClient;
  now?: () => number;
  ttlMs?: number;
};

export class DescribeCache implements SoqlCompletionSource {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private toolingPreferred = false;
  private globals = new Map<Source, Map<string, string>>();
  private globalsSettled = false;
  private warmPromise: Promise<void> | undefined;
  private readonly objects = new Map<string, CompletionObject>();
  private readonly pending = new Map<string, Promise<CompletionObject | undefined>>();

  public constructor(private readonly options: DescribeCacheOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? describeCacheTtlMs;
  }

  /** `\tooling on` flips which API wins object-name conflicts. */
  public setToolingPreferred(on: boolean): void {
    this.toolingPreferred = on;
  }

  /**
   * Starts loading both global describes; the promise resolves once both have
   * settled. Callers fire this at startup and never await it on the prompt.
   */
  public warm(): Promise<void> {
    this.warmPromise ??= this.loadGlobals();

    return this.warmPromise;
  }

  public globalObjectNames(): readonly string[] | undefined {
    if (!this.globalsSettled) {
      return undefined;
    }

    const [first, second] = this.orderedSources();
    const merged = new Map(this.globals.get(first) ?? []);

    for (const [lower, name] of this.globals.get(second) ?? []) {
      if (!merged.has(lower)) {
        merged.set(lower, name);
      }
    }

    return [...merged.values()].sort((a, b) => a.localeCompare(b));
  }

  public getObject(name: string): CompletionObject | undefined {
    const { source, canonical } = this.locate(name);
    const loaded = this.objects.get(objectKey(source, canonical));

    if (loaded == null) {
      void this.loadObject(name);
    }

    return loaded;
  }

  /**
   * Loads one object describe (memory, then fresh disk, then API), deduping
   * concurrent requests. Resolves undefined on any failure.
   */
  public async loadObject(name: string): Promise<CompletionObject | undefined> {
    const { source, canonical } = this.locate(name);

    if (!safeNamePattern.test(canonical)) {
      return undefined;
    }

    const key = objectKey(source, canonical);
    const loaded = this.objects.get(key);

    if (loaded != null) {
      return loaded;
    }

    const pending = this.pending.get(key);

    if (pending != null) {
      return pending;
    }

    const promise = this.fetchObject(source, canonical, key).finally(() => this.pending.delete(key));

    this.pending.set(key, promise);

    return promise;
  }

  /**
   * True when the object exists only in the Tooling API - the signal for
   * routing its queries there directly. Undefined until globals have loaded.
   */
  public isToolingOnly(name: string): boolean | undefined {
    if (!this.globalsSettled) {
      return undefined;
    }

    const lower = name.toLowerCase();

    return !(this.globals.get('regular')?.has(lower) ?? false) && (this.globals.get('tooling')?.has(lower) ?? false);
  }

  /** `\refresh`: drop the org's disk cache and memory, then re-fetch globals. */
  public async refresh(): Promise<void> {
    await rm(this.options.directory, { recursive: true, force: true });
    this.objects.clear();
    this.pending.clear();
    this.globals.clear();
    this.globalsSettled = false;
    this.warmPromise = undefined;

    await this.warm();
  }

  private orderedSources(): [Source, Source] {
    return this.toolingPreferred ? ['tooling', 'regular'] : ['regular', 'tooling'];
  }

  /** Which API serves this object, and its canonical (describe-cased) name. */
  private locate(name: string): { source: Source; canonical: string } {
    const lower = name.toLowerCase();

    for (const source of this.orderedSources()) {
      const canonical = this.globals.get(source)?.get(lower);

      if (canonical != null) {
        return { source, canonical };
      }
    }

    return { source: this.orderedSources()[0], canonical: name };
  }

  private async loadGlobals(): Promise<void> {
    await Promise.all([this.loadGlobal('regular'), this.loadGlobal('tooling')]);
    this.globalsSettled = true;
  }

  private async loadGlobal(source: Source): Promise<void> {
    const file = join(this.options.directory, source === 'regular' ? 'global.json' : 'tooling-global.json');
    const cached = await this.readEnvelope<GlobalEntry[]>(file);

    if (cached != null) {
      this.globals.set(source, toNameIndex(cached));

      return;
    }

    try {
      const client = source === 'regular' ? this.options.regular : this.options.tooling;
      const entries = (await client.describeGlobal()).sobjects.map(({ name, queryable }) => ({ name, queryable }));

      this.globals.set(source, toNameIndex(entries));
      await this.writeEnvelope(file, entries);
    } catch {
      // Completion for this source stays keyword-only until a \refresh.
    }
  }

  private async fetchObject(source: Source, canonical: string, key: string): Promise<CompletionObject | undefined> {
    const file = join(this.options.directory, source === 'regular' ? 'sobjects' : 'tooling', `${canonical}.json`);
    const cached = await this.readEnvelope<CompletionObject>(file);

    if (cached != null) {
      this.objects.set(key, cached);

      return cached;
    }

    try {
      const client = source === 'regular' ? this.options.regular : this.options.tooling;
      const object = slimObject(await client.describeSObject(canonical));

      this.objects.set(key, object);
      await this.writeEnvelope(file, object);

      return object;
    } catch {
      return undefined;
    }
  }

  private async readEnvelope<T>(file: string): Promise<T | undefined> {
    try {
      const envelope = JSON.parse(await readFile(file, 'utf8')) as Envelope<T>;

      if (typeof envelope.fetchedAt !== 'number' || this.now() - envelope.fetchedAt > this.ttlMs) {
        return undefined;
      }

      return envelope.data;
    } catch {
      return undefined;
    }
  }

  private async writeEnvelope<T>(file: string, data: T): Promise<void> {
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ fetchedAt: this.now(), data } satisfies Envelope<T>), 'utf8');
    } catch {
      // The in-memory copy still serves this session.
    }
  }
}

const objectKey = (source: Source, canonical: string): string => `${source}:${canonical.toLowerCase()}`;

/** lower-cased name -> canonical casing, queryable entries only. */
const toNameIndex = (entries: readonly GlobalEntry[]): Map<string, string> =>
  new Map(entries.filter((entry) => entry.queryable !== false).map((entry) => [entry.name.toLowerCase(), entry.name]));
