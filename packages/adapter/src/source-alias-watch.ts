import path from 'node:path';

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function aliasMatch(alias: string, specifier: string): string | undefined {
  const star = alias.indexOf('*');
  if (star === -1) return alias === specifier ? '' : undefined;
  const prefix = alias.slice(0, star);
  const suffix = alias.slice(star + 1);
  if (
    specifier.length < prefix.length + suffix.length ||
    !specifier.startsWith(prefix) ||
    !specifier.endsWith(suffix)
  )
    return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/** Conservative candidates include inherited base URLs, so missing aliased files remain watched. */
export function sourceAliasCandidates(
  configs: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  specifier: string,
): readonly string[] {
  if (specifier.startsWith('node:') || specifier.startsWith('cloudflare:')) return [];
  const bases = new Set<string>();
  for (const [file, config] of configs) {
    const options = objectOf(config['compilerOptions']);
    if (typeof options?.['baseUrl'] === 'string')
      bases.add(path.resolve(path.dirname(file), options['baseUrl']));
  }
  const candidates = new Set([...bases].map((base) => path.resolve(base, specifier)));
  for (const [file, config] of configs) {
    const options = objectOf(config['compilerOptions']);
    const paths = objectOf(options?.['paths']);
    if (paths === undefined) continue;
    const directories = new Set([path.dirname(file), ...bases]);
    for (const [alias, targets] of Object.entries(paths)) {
      const match = aliasMatch(alias, specifier);
      if (match === undefined || !Array.isArray(targets)) continue;
      for (const target of targets as unknown[]) {
        if (typeof target !== 'string') continue;
        for (const directory of directories)
          candidates.add(path.resolve(directory, target.replace('*', match)));
      }
    }
  }
  return [...candidates];
}
