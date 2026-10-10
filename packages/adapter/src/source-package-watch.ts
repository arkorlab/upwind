import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { aliasMatch } from './source-alias-watch.ts';

function packageScope(
  startingDirectory: string,
  beforeRead: (file: string) => void,
):
  | {
      readonly directory: string;
      readonly imports: unknown;
      readonly name: unknown;
      readonly exports: unknown;
    }
  | undefined {
  let directory = startingDirectory;
  for (;;) {
    if (path.basename(directory) === 'node_modules') return;
    const file = path.join(directory, 'package.json');
    beforeRead(file);
    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
        const fields = parsed as Record<string, unknown>;
        return {
          directory,
          imports: fields['imports'],
          name: fields['name'],
          exports: fields['exports'],
        };
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
  const candidates = Object.entries(imports as Record<string, unknown>).flatMap(
    ([alias, values]) => {
      const match = aliasMatch(alias, specifier);
      if (match === undefined) return [];
      return importTargets(values).flatMap((target) => {
        // Package import patterns substitute every star; exact aliases keep literal filenames.
        const substituted = alias.includes('*') ? target.replaceAll('*', () => match) : target;
        return substituted.startsWith('./')
          ? [path.resolve(scope.directory, substituted)]
          : watchPackageExports(scope.directory, substituted, beforeRead);
      });
    },
  );
  return [...new Set(candidates)];
}

function exportTargets(exports: unknown, subpath: string): readonly string[] {
  if (typeof exports !== 'object' || exports === null || Array.isArray(exports))
    return subpath === '.' ? importTargets(exports) : [];
  const entries = Object.entries(exports as Record<string, unknown>);
  if (entries.every(([key]) => !key.startsWith('.')))
    return subpath === '.' ? importTargets(exports) : [];
  return entries.flatMap(([alias, value]) => {
    const match = aliasMatch(alias, subpath);
    if (match === undefined) return [];
    return importTargets(value).map((target) =>
      alias.includes('*') ? target.replaceAll('*', () => match) : target,
    );
  });
}

function dependencyTargets(
  root: string,
  subpath: string,
  beforeRead: (file: string) => void,
): readonly string[] {
  const manifest = path.join(root, 'package.json');
  beforeRead(manifest);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    // Missing and malformed manifests remain watched; esbuild reports their resolution error.
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const fields = parsed as Record<string, unknown>;
  return [exportTargets(fields['exports'], subpath), importTargets(fields['browser'])].flatMap(
    (targets) => {
      return targets
        .filter((target) => target.startsWith('./'))
        .map((target) => path.resolve(root, target));
    },
  );
}

/** Missing exports and legacy entries need a watch even when esbuild cannot resolve the package. */
export function watchPackageExports(
  startingDirectory: string,
  specifier: string,
  beforeRead: (file: string) => void,
): readonly string[] {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('#') ||
    specifier.includes(':') ||
    path.isAbsolute(specifier) ||
    isBuiltin(specifier)
  )
    return [];
  const parts = specifier.split('/');
  const length = specifier.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, length).join('/');
  const subpath = parts.length === length ? '.' : `./${parts.slice(length).join('/')}`;
  const scope = packageScope(startingDirectory, beforeRead);
  if (scope?.name === name && scope.exports !== undefined)
    return dependencyTargets(scope.directory, subpath, beforeRead);
  const candidates = new Set<string>();
  let directory = startingDirectory;
  for (;;) {
    const root = path.join(directory, 'node_modules', name);
    candidates.add(root);
    if (subpath !== '.') candidates.add(path.resolve(root, subpath));
    for (const target of dependencyTargets(root, subpath, beforeRead)) candidates.add(target);
    if (existsSync(root)) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [...candidates];
}
