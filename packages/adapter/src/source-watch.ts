import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin } from 'rolldown';

import { watchSourceConfigs } from './source-config-watch.ts';
import { watchPackageExports, watchPackageImports } from './source-package-watch.ts';

/** Rolldown's own, for a build that names none (`resolve.extensions`). */
const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.json'];
/** Rolldown's own for the `browser` platform, for a build that names none (`resolve.mainFields`). */
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
    // Missing or malformed manifests are left for the bundler to diagnose.
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

/** Capture dependency versions before Rolldown reads them, including files discovered by imports. */
export function watchBuildSources(beforeRead: (file: string) => void): Plugin {
  const watchConfigs = watchSourceConfigs(beforeRead);
  let workingDirectory = process.cwd();
  let extensions: readonly string[] = RESOLVE_EXTENSIONS;
  let mainFields: readonly string[] = MAIN_FIELDS;
  return {
    name: 'upwind-source-watch',
    options(options) {
      workingDirectory = options.cwd ?? workingDirectory;
      extensions = options.resolve?.extensions ?? RESOLVE_EXTENSIONS;
      mainFields = options.resolve?.mainFields ?? MAIN_FIELDS;
    },
    resolveId(source, importer): undefined {
      if (importer === undefined) return;
      // What a file imports resolves from the file's directory, and what an entry generated as
      // source imports, from the working directory; the bundler's other modules of its own import
      // nothing of the project's.
      let resolveDir: string;
      if (path.isAbsolute(importer)) resolveDir = path.dirname(importer);
      // eslint-disable-next-line unicorn/no-this-outside-of-class -- the plugin API hands the context as `this`
      else if (this.getModuleInfo(importer)?.isEntry === true) resolveDir = workingDirectory;
      else return;
      const specifier = source.replace(/\?module$/u, '');
      const aliases = [
        ...watchConfigs(resolveDir, specifier),
        ...watchPackageImports(resolveDir, specifier, beforeRead),
        ...watchPackageExports(resolveDir, specifier, beforeRead),
      ];
      for (const alias of aliases) {
        watchCandidates(alias, extensions, beforeRead);
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
      const target = path.resolve(resolveDir, specifier);
      watchCandidates(target, extensions, beforeRead);
      watchPackageEntries(target, mainFields, extensions, beforeRead);
    },
    load(id): undefined {
      // A file: every module of the bundler's own is named by something other than a path.
      if (!path.isAbsolute(id)) return;
      watchConfigs(path.dirname(id));
      beforeRead(id);
    },
  };
}
