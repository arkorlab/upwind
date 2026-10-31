const STORAGE_KEY = 'upwind.next-cache-storage@1';
// Production minification can append this initializer to an earlier variable declaration.
const STORES =
  /(?:(?<![\w$])(?:const|let|var)\s+|,\s*)(?<store>[\w$]+)\s*=\s*\{\s*type:\s*(?<quote>["'`])unstable-cache\k<quote>/gu;
const RUNS =
  /(?<![\w$.])(?<storage>(?:[\w$]+\.)?workUnitAsyncStorage)\.run\(\s*(?<store>[\w$]+)\s*,/gu;

export function isUnstableCacheSource(source: string): boolean {
  return source.includes('incrementalCache missing in unstable_cache');
}

/** Register each graph's exact storage before any cold or background callback can return data. */
export function unstableCacheRegistrations(
  source: string,
): readonly { index: number; text: string }[] {
  if (!isUnstableCacheSource(source)) return [];
  const stores = new Set([...source.matchAll(STORES)].map((match) => match.groups?.['store']));
  const insertions = [...source.matchAll(RUNS)].flatMap((match) => {
    const storage = match.groups?.['storage'];
    return storage !== undefined && stores.has(match.groups?.['store'])
      ? [
          { index: match.index, text: `(globalThis[Symbol.for("${STORAGE_KEY}")]?.(` },
          { index: match.index + storage.length, text: `)??${storage})` },
        ]
      : [];
  });
  if (stores.size === 0 || insertions.length === 0) {
    throw new Error('resource-cache-bridge: Next unstable cache context was not found');
  }
  return insertions;
}
