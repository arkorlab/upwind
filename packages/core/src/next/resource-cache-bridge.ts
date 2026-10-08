/** Shared by the Function bundler and Node's synchronous build/dev loader. No Next dependency. */
const REVALIDATION_MARK = 'revalidate-tag-single-arg';
const CACHE_STORAGE = 'upwind.next-cache-storage@1';
const REVALIDATION = 'upwind.next-revalidation@1';
const EXPORT_PREFIX = 'export ';
// The identifier boundary prevents retrying a failed match at every character of a long name.
const SNAPSHOTS =
  /(?<![\w$.])(?<snapshot>[\w$]+)\.runInCleanSnapshot\((?<restore>[\w$]+),\s*(?<work>[\w$]+),/gu;
const DYNAMIC_RUNS =
  /(?<![\w$.])(?<unit>(?:[\w$]+\.)?workUnitAsyncStorage)\.run\(\s*[\w$]+\s*,\s*\(\)\s*=>\s*(?:[\w$]+\.)?dynamicAccessAsyncStorage\.run\(/gu;
const WORK_RUNS =
  /(?<![\w$.])(?<storage>(?:[\w$]+\.)?workAsyncStorage)\.run\(\s*[\w$]+\s*,\s*(?<entry>[\w$]+)\s*,/gu;
const WORK_GETTERS = /(?<![\w$.])(?<storage>(?:[\w$]+\.)?workAsyncStorage)\.getStore\(/u;
const UNIT_GETTERS = /(?<![\w$.])(?<storage>(?:[\w$]+\.)?workUnitAsyncStorage)\.getStore\(/u;

export interface ResourceCacheBridgeResult {
  readonly contents: string;
  readonly edits: number;
}

interface Insertion {
  readonly index: number;
  readonly text: string;
}

function isCacheWrapper(source: string): boolean {
  return source.includes('cacheLifeProfiles.default') && source.includes('runInCleanSnapshot');
}

export function isResourceCacheBridgeSource(source: string): boolean {
  return isCacheWrapper(source) || source.includes(REVALIDATION_MARK);
}

function preceding(
  source: string,
  expression: RegExp,
  before: number,
): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const match of source.matchAll(expression)) {
    if (match.index >= before) break;
    last = match;
  }
  return last;
}

function restorePrimarySnapshots(source: string): ResourceCacheBridgeResult {
  let edits = 0;
  const contents = source.replaceAll(SNAPSHOTS, (...args: unknown[]) => {
    const groups = args.at(-1) as { snapshot: string; restore: string; work: string };
    if (groups.snapshot !== groups.work) {
      throw new Error(
        'resource-cache-bridge: Next clean snapshot does not restore its own work store',
      );
    }
    edits += 1;
    return `${groups.snapshot}.runInCleanSnapshot(${groups.restore},(globalThis[Symbol.for("upwind.resource-primary-store@1")]?.(${groups.work})??${groups.work}),`;
  });
  return { contents, edits };
}

function cacheRegistration(source: string, dynamic: RegExpExecArray): Insertion {
  const work = preceding(source, WORK_RUNS, dynamic.index);
  const storage = work?.groups?.['storage'];
  const unitStorage = dynamic.groups?.['unit'];
  const entry = work?.groups?.['entry'];
  if (
    work === undefined ||
    storage === undefined ||
    unitStorage === undefined ||
    entry === undefined
  ) {
    throw new Error('resource-cache-bridge: Next cache context stores were not found');
  }
  // The captured identifier is matched literally; no dynamic regular expression is needed.
  const index = source.indexOf(`function ${entry}(`, work.index + work[0].length);
  if (index === -1 || index >= dynamic.index) {
    throw new Error('resource-cache-bridge: Next cache context entry was not found');
  }
  return {
    index,
    text: `;globalThis[Symbol.for("${CACHE_STORAGE}")]?.(${unitStorage});globalThis[Symbol.for("${REVALIDATION}")]?.({workStorage:${storage},unitStorage:${unitStorage}});`,
  };
}

function cacheRegistrations(source: string): Insertion[] {
  return Array.from(source.matchAll(DYNAMIC_RUNS), (dynamic) => cacheRegistration(source, dynamic));
}

function revalidationRegistration(source: string, index: number): Insertion {
  const declaration = preceding(source, /function (?<name>[\w$]+)\(/gu, index);
  const name = declaration?.groups?.['name'];
  const rest = source.slice(index);
  const work = WORK_GETTERS.exec(rest)?.groups?.['storage'];
  const unit = UNIT_GETTERS.exec(rest)?.groups?.['storage'];
  if (declaration === undefined || name === undefined || work === undefined || unit === undefined) {
    throw new Error('resource-cache-bridge: Next revalidateTag provider was not found');
  }
  const exported =
    source.slice(declaration.index - EXPORT_PREFIX.length, declaration.index) === EXPORT_PREFIX;
  return {
    index: exported ? declaration.index - EXPORT_PREFIX.length : declaration.index,
    text: `;globalThis[Symbol.for("${REVALIDATION}")]?.({workStorage:${work},unitStorage:${unit},revalidateTag:${name}});`,
  };
}

function revalidationRegistrations(source: string): Insertion[] {
  return Array.from(source.matchAll(/revalidate-tag-single-arg/gu), (marker) =>
    revalidationRegistration(source, marker.index),
  );
}

function insertRegistrations(source: string, insertions: readonly Insertion[]): string {
  let contents = source;
  const ordered = insertions.toSorted((a, b) => b.index - a.index);
  for (const insertion of ordered) {
    contents =
      contents.slice(0, insertion.index) + insertion.text + contents.slice(insertion.index);
  }
  return contents;
}

/** Register exact module-scope stores before fills; cache GETs gain no callback, context or I/O. */
export function resourceCacheBridge(source: string): ResourceCacheBridgeResult {
  if (
    source.includes(`Symbol.for("${CACHE_STORAGE}")`) ||
    source.includes(`Symbol.for("${REVALIDATION}")`)
  ) {
    return { contents: source, edits: 0 };
  }
  const cacheWrapper = isCacheWrapper(source);
  const snapshots = cacheWrapper ? restorePrimarySnapshots(source) : { contents: source, edits: 0 };
  const caches = cacheWrapper ? cacheRegistrations(snapshots.contents) : [];
  if (cacheWrapper && (snapshots.edits === 0 || caches.length !== snapshots.edits)) {
    throw new Error('resource-cache-bridge: Next cache context and clean snapshot counts differ');
  }
  const insertions = [...caches, ...revalidationRegistrations(snapshots.contents)];
  return {
    contents: insertRegistrations(snapshots.contents, insertions),
    edits: insertions.length + snapshots.edits,
  };
}
