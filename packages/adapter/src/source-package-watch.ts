import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { aliasMatch } from './source-alias-watch.ts';

function packageScope(
  startingDirectory: string,
  beforeRead: (file: string) => void,
): { readonly directory: string; readonly imports: unknown } | undefined {
  let directory = startingDirectory;
  for (;;) {
    const file = path.join(directory, 'package.json');
    beforeRead(file);
    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
        return { directory, imports: (parsed as Record<string, unknown>)['imports'] };
      } catch {
        // esbuild diagnoses malformed manifests; their creation and correction stay watched.
        return;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/** All condition and fallback targets are conservative source candidates. */
function importTargets(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value as Record<string, unknown>).flatMap((target) => importTargets(target));
}

export function watchPackageImports(
  directory: string,
  specifier: string,
  beforeRead: (file: string) => void,
): readonly string[] {
  if (!specifier.startsWith('#')) return [];
  const scope = packageScope(directory, beforeRead);
  if (scope === undefined) return [];
  const { imports } = scope;
  if (typeof imports !== 'object' || imports === null || Array.isArray(imports)) return [];
  const candidates = new Set<string>();
  for (const [alias, values] of Object.entries(imports as Record<string, unknown>)) {
    const match = aliasMatch(alias, specifier);
    if (match === undefined) continue;
    for (const target of importTargets(values)) {
      if (!target.startsWith('./')) continue;
      // Package import patterns substitute every star; exact aliases keep literal filenames.
      const substituted = alias.includes('*') ? target.replaceAll('*', () => match) : target;
      candidates.add(path.resolve(scope.directory, substituted));
    }
  }
  return [...candidates];
}
