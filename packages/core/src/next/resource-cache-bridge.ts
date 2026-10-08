/** Shared by the Function bundler and Node's synchronous build/dev loader. No Next dependency. */
const CACHE_STORAGE = 'upwind.next-cache-storage@1';
const REVALIDATION = 'upwind.next-revalidation@1';
const EXPORT_PREFIX = 'export ';
const REVALIDATION_MARK = 'revalidate-tag-single-arg';
// A documentation URL alone is application content. Match Next's warning and its public provider.
// Both quote spellings occur in emitted chunks; every repetition below has a fixed literal boundary.
const REVALIDATION_WARNINGS =
  /without the second argument is now deprecated, add second argument of \\?"max\\?" or use \\?"updateTag\\?"\. See more info here: https:\/\/nextjs\.org\/docs\/messages\/revalidate-tag-single-arg/gu;
const REVALIDATION_FUNCTION_EXPORTS =
  /(?<![\w$])revalidateTag["']?\s*:\s*function\s*\(\)\s*\{\s*return\s+(?<name>[\w$]+)/gu;
const REVALIDATION_ARROW_EXPORTS =
  /(?<![\w$])revalidateTag["']?\s*:\s*\(\)\s*=>\s*(?<name>[\w$]+)/gu;
const REVALIDATION_ARRAY_EXPORTS = /["']revalidateTag["']\s*,\s*\(\)\s*=>\s*(?<name>[\w$]+)/gu;
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

interface RevalidationDeclaration {
  readonly index: number;
  readonly name: string;
  readonly afterWarning: number;
}

function isCacheWrapper(source: string): boolean {
  return source.includes('cacheLifeProfiles.default') && source.includes('runInCleanSnapshot');
}

function isRevalidationModule(source: string): boolean {
  // Keep candidate detection independent of the declaration/warning syntax we must validate.
  return (
    source.includes(REVALIDATION_MARK) &&
    source.includes('workAsyncStorage') &&
    source.includes('workUnitAsyncStorage')
  );
}

export function isResourceCacheBridgeSource(source: string): boolean {
  return isCacheWrapper(source) || isRevalidationModule(source);
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

function revalidationDeclarations(source: string): RevalidationDeclaration[] {
  const declarations = new Map<number, RevalidationDeclaration>();
  for (const warning of source.matchAll(REVALIDATION_WARNINGS)) {
    // Follow the public export to its declaration: Turbopack can rename it, and helpers may follow it.
    const exports = [
      preceding(source, REVALIDATION_FUNCTION_EXPORTS, warning.index),
      preceding(source, REVALIDATION_ARROW_EXPORTS, warning.index),
      preceding(source, REVALIDATION_ARRAY_EXPORTS, warning.index),
    ];
    let name = 'revalidateTag';
    const directExport = source.lastIndexOf(`export function ${name}(`, warning.index);
    let index = directExport === -1 ? -1 : directExport + EXPORT_PREFIX.length;
    for (const exported of exports) {
      const exportedName = exported?.groups?.['name'];
      if (exported === undefined || exportedName === undefined) continue;
      // The module declaration follows its export map; nested helpers can reuse its minified name.
      const exportedIndex = source.indexOf(
        `function ${exportedName}(`,
        exported.index + exported[0].length,
      );
      if (exportedIndex > index && exportedIndex < warning.index) {
        name = exportedName;
        index = exportedIndex;
      }
    }
    if (index !== -1 && !declarations.has(index))
      declarations.set(index, { index, name, afterWarning: warning.index + warning[0].length });
  }
  return [...declarations.values()];
}

/** The adapter counts the same native providers that the build/dev transform recognizes. */
export function resourceCacheBridgeRevalidations(source: string): number {
  return isRevalidationModule(source) ? revalidationDeclarations(source).length : 0;
}

function revalidationRegistration(source: string, provider: RevalidationDeclaration): Insertion {
  const { index, name, afterWarning } = provider;
  const rest = source.slice(afterWarning);
  const work = WORK_GETTERS.exec(rest)?.groups?.['storage'];
  const unit = UNIT_GETTERS.exec(rest)?.groups?.['storage'];
  if (work === undefined || unit === undefined) {
    throw new Error('resource-cache-bridge: Next revalidateTag provider was not found');
  }
  const exported = source.slice(index - EXPORT_PREFIX.length, index) === EXPORT_PREFIX;
  return {
    index: exported ? index - EXPORT_PREFIX.length : index,
    text: `;globalThis[Symbol.for("${REVALIDATION}")]?.({workStorage:${work},unitStorage:${unit},revalidateTag:${name}});`,
  };
}

function revalidationRegistrations(source: string): Insertion[] {
  if (!isRevalidationModule(source)) return [];
  return revalidationDeclarations(source).map((declaration) =>
    revalidationRegistration(source, declaration),
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
  if (isRevalidationModule(source) && resourceCacheBridgeRevalidations(source) === 0) {
    throw new Error('resource-cache-bridge: Next revalidateTag provider was not found');
  }
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
