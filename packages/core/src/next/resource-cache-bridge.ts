/** Shared by the Function bundler and Node's synchronous build/dev loader. No Next dependency. */
const REVALIDATION_MARK = 'revalidate-tag-single-arg';
const CACHE_STORAGE = 'upwind.next-cache-storage@1';
const REVALIDATION = 'upwind.next-revalidation@1';

export interface ResourceCacheBridgeResult {
  readonly contents: string;
  readonly edits: number;
}

export function isResourceCacheBridgeSource(source: string): boolean {
  return (
    (source.includes('cacheLifeProfiles.default') && source.includes('runInCleanSnapshot')) ||
    source.includes(REVALIDATION_MARK)
  );
}

interface Insertion {
  readonly index: number;
  readonly text: string;
}

function preceding(
  source: string,
  expression: RegExp,
  before: number,
): RegExpMatchArray | undefined {
  let last: RegExpMatchArray | undefined;
  for (const match of source.matchAll(expression)) {
    if ((match.index ?? 0) >= before) break;
    last = match;
  }
  return last;
}

/**
 * Register module-scope references at evaluation, including on cache hits and in applications
 * which never import next/cache. No extra async context, callback or I/O on a cache GET.
 */
export function resourceCacheBridge(source: string): ResourceCacheBridgeResult {
  if (
    source.includes(`Symbol.for("${CACHE_STORAGE}")`) ||
    source.includes(`Symbol.for("${REVALIDATION}")`)
  ) {
    return { contents: source, edits: 0 };
  }
  const insertions: Insertion[] = [];
  let snapshots = 0;
  if (source.includes('cacheLifeProfiles.default') && source.includes('runInCleanSnapshot')) {
    source = source.replaceAll(
      /(?<snapshot>[\w$]+)\.runInCleanSnapshot\((?<restore>[\w$]+),\s*(?<work>[\w$]+),/gu,
      (...args: unknown[]) => {
        const groups = args.at(-1) as Record<string, string>;
        if (groups['snapshot'] !== groups['work']) {
          throw new Error(
            'resource-cache-bridge: Next clean snapshot does not restore its own work store',
          );
        }
        snapshots++;
        return `${groups['snapshot']}.runInCleanSnapshot(${groups['restore']},(globalThis[Symbol.for("upwind.resource-primary-store@1")]?.(${groups['work']})??${groups['work']}),`;
      },
    );
    const dynamicRuns =
      /(?<unit>(?:[\w$]+\.)?workUnitAsyncStorage)\.run\(\s*[\w$]+\s*,\s*\(\)\s*=>\s*(?:[\w$]+\.)?dynamicAccessAsyncStorage\.run\(/gu;
    const workRuns =
      /(?<storage>(?:[\w$]+\.)?workAsyncStorage)\.run\(\s*[\w$]+\s*,\s*(?<entry>[\w$]+)\s*,/gu;
    for (const dynamic of source.matchAll(dynamicRuns)) {
      const work = preceding(source, workRuns, dynamic.index ?? 0);
      const storage = work?.groups?.['storage'];
      const unitStorage = dynamic.groups?.['unit'];
      const entry = work?.groups?.['entry'];
      if (storage === undefined || unitStorage === undefined || entry === undefined) {
        throw new Error('resource-cache-bridge: Next cache context stores were not found');
      }
      const declaration = new RegExp(`function ${entry.replaceAll('$', '\\$')}\\(`, 'gu');
      const match = [...source.matchAll(declaration)].find(
        (candidate) =>
          (candidate.index ?? 0) > (work?.index ?? 0) &&
          (candidate.index ?? 0) < (dynamic.index ?? 0),
      );
      if (match?.index === undefined) {
        throw new Error('resource-cache-bridge: Next cache context entry was not found');
      }
      insertions.push({
        index: match.index,
        text: `;globalThis[Symbol.for("${CACHE_STORAGE}")]?.(${unitStorage});globalThis[Symbol.for("${REVALIDATION}")]?.({workStore:()=>${storage}.getStore(),unitStore:()=>${unitStorage}.getStore()});`,
      });
    }
    if (snapshots === 0 || insertions.length !== snapshots) {
      throw new Error('resource-cache-bridge: Next cache context and clean snapshot counts differ');
    }
  }
  for (const marker of source.matchAll(/revalidate-tag-single-arg/gu)) {
    const index = marker.index ?? 0;
    const declaration = preceding(source, /function (?<name>[\w$]+)\(/gu, index);
    const name = declaration?.groups?.['name'];
    const rest = source.slice(index);
    const work = /(?<storage>(?:[\w$]+\.)?workAsyncStorage)\.getStore\(/u.exec(rest)?.groups?.[
      'storage'
    ];
    const unit = /(?<storage>(?:[\w$]+\.)?workUnitAsyncStorage)\.getStore\(/u.exec(rest)?.groups?.[
      'storage'
    ];
    if (
      declaration?.index === undefined ||
      name === undefined ||
      work === undefined ||
      unit === undefined
    ) {
      throw new Error('resource-cache-bridge: Next revalidateTag provider was not found');
    }
    insertions.push({
      index:
        source.slice(declaration.index - 7, declaration.index) === 'export '
          ? declaration.index - 7
          : declaration.index,
      text: `;globalThis[Symbol.for("${REVALIDATION}")]?.({workStore:()=>${work}.getStore(),unitStore:()=>${unit}.getStore(),revalidateTag:${name}});`,
    });
  }
  let contents = source;
  for (const insertion of insertions.toSorted((a, b) => b.index - a.index)) {
    contents =
      contents.slice(0, insertion.index) + insertion.text + contents.slice(insertion.index);
  }
  return { contents, edits: insertions.length + snapshots };
}
