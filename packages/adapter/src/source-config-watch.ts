import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';

import { sourceAliasCandidates } from './source-alias-watch.ts';

const TS_CONFIG = 'tsconfig.json';

function configOf(file: string): Readonly<Record<string, unknown>> | undefined {
  let value: unknown;
  try {
    value = parseJsonc(readFileSync(file, 'utf8'), [], { allowTrailingComma: true }) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function configParents(config: Readonly<Record<string, unknown>>): readonly string[] {
  const bases = config['extends'];
  if (typeof bases === 'string') return [bases];
  if (Array.isArray(bases))
    return (bases as unknown[]).filter((base): base is string => typeof base === 'string');
  return [];
}

/** Capture configuration before resolution, including inherited and newly created configs. */
export function watchSourceConfigs(
  beforeRead: (file: string) => void,
): (directory: string, specifier?: string) => readonly string[] {
  const visited = new Set<string>();
  const configs = new Map<string, Readonly<Record<string, unknown>>>();
  function watchFile(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    beforeRead(file);
    const config = configOf(file);
    if (config === undefined) return;
    configs.set(file, config);
    for (const base of configParents(config)) {
      if (base.startsWith('.') || path.isAbsolute(base)) {
        const target = path.resolve(path.dirname(file), base);
        watchFile(target);
        if (path.extname(target) === '') watchFile(`${target}.json`);
        continue;
      }
      const require = createRequire(file);
      const directories = require.resolve.paths(base);
      if (directories !== null)
        for (const directory of directories) {
          const target = path.join(directory, base);
          watchFile(target);
          watchFile(`${target}.json`);
          watchFile(path.join(target, TS_CONFIG));
        }
      try {
        watchFile(require.resolve(base));
      } catch {
        // esbuild reports unresolved inherited configs; candidates remain watched for recovery.
      }
    }
  }
  return (initial: string, specifier?: string): readonly string[] => {
    let directory = path.resolve(initial);
    for (;;) {
      watchFile(path.join(directory, TS_CONFIG));
      watchFile(path.join(directory, 'jsconfig.json'));
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (specifier === undefined) return [];
    return sourceAliasCandidates(configs, specifier);
  };
}
