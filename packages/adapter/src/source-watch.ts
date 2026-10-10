import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin } from 'esbuild';

import { watchSourceConfigs } from './source-config-watch.ts';
import { watchPackageExports, watchPackageImports } from './source-package-watch.ts';

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'];
const MAIN_FIELDS = ['browser', 'module', 'main'];
const PACKAGE_MANIFEST = 'package.json';
const REWRITTEN_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  '.cjs': ['.cts'],
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
};

function watchCandidates(
  target: string,
  extensions: readonly string[],
  beforeRead: (file: string) => void,
): void {
  beforeRead(target);
  for (const extension of extensions) {
    beforeRead(`${target}${extension}`);
    beforeRead(path.join(target, `index${extension}`));
  }
  const originalExtension = path.extname(target);
  const rewritten = REWRITTEN_EXTENSIONS[originalExtension];
  if (rewritten !== undefined)
    for (const extension of rewritten)
      beforeRead(`${target.slice(0, -originalExtension.length)}${extension}`);
}

/** A directory may already exist while the nested entry declared by its manifest does not. */
function watchPackageEntries(
  target: string,
  mainFields: readonly string[],
  extensions: readonly string[],
  beforeRead: (file: string) => void,
): void {
  const manifest = path.join(target, PACKAGE_MANIFEST);
  beforeRead(manifest);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
  } catch {
    // Missing or malformed manifests are left for esbuild to diagnose.
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
  const fields = parsed as Record<string, unknown>;
  for (const field of mainFields) {
    const entry = fields[field];
    if (typeof entry === 'string')
      watchCandidates(path.resolve(target, entry), extensions, beforeRead);
  }
}

/** Capture dependency versions before esbuild reads them, including files discovered by imports. */
export function watchBuildSources(beforeRead: (file: string) => void): Plugin {
  return {
    name: 'upwind-source-watch',
    setup(builder) {
      const watchConfigs = watchSourceConfigs(beforeRead);
      // eslint-disable-next-line require-unicode-regexp -- esbuild filters are Go regular expressions.
      builder.onResolve({ filter: /.*/, namespace: 'file' }, (args): undefined => {
        const specifier = args.path.replace(/\?module$/u, '');
        const aliases = [
          ...watchConfigs(args.resolveDir, specifier),
          ...watchPackageImports(args.resolveDir, specifier, beforeRead),
          ...watchPackageExports(args.resolveDir, specifier, beforeRead),
        ];
        const extensions = builder.initialOptions.resolveExtensions ?? RESOLVE_EXTENSIONS;
        for (const alias of aliases) {
          watchCandidates(alias, extensions, beforeRead);
          const mainFields = builder.initialOptions.mainFields ?? MAIN_FIELDS;
          watchPackageEntries(alias, mainFields, extensions, beforeRead);
        }
        if (
          specifier !== '.' &&
          specifier !== '..' &&
          !specifier.startsWith('./') &&
          !specifier.startsWith('../') &&
          !path.isAbsolute(specifier)
        )
          return;
        const target = path.resolve(args.resolveDir, specifier);
        watchCandidates(target, extensions, beforeRead);
        const mainFields = builder.initialOptions.mainFields ?? MAIN_FIELDS;
        watchPackageEntries(target, mainFields, extensions, beforeRead);
      });
      // eslint-disable-next-line require-unicode-regexp -- esbuild filters are Go regular expressions.
      builder.onLoad({ filter: /.*/, namespace: 'file' }, (args): undefined => {
        watchConfigs(path.dirname(args.path));
        beforeRead(args.path);
      });
    },
  };
}
