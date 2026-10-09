import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';

function configParents(file: string): readonly string[] {
  let value: unknown;
  try {
    value = parseJsonc(readFileSync(file, 'utf8'), [], { allowTrailingComma: true }) as unknown;
  } catch {
    return [];
  }
  if (typeof value !== 'object' || value === null || !('extends' in value)) return [];
  const bases: unknown = value.extends;
  if (typeof bases === 'string') return [bases];
  if (Array.isArray(bases))
    return (bases as unknown[]).filter((base): base is string => typeof base === 'string');
  return [];
}

/** Capture configuration before resolution, including inherited and newly created configs. */
export function watchSourceConfigs(
  beforeRead: (file: string) => void,
): (directory: string) => void {
  const visited = new Set<string>();
  function watchFile(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    beforeRead(file);
    for (const base of configParents(file)) {
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
          watchFile(path.join(target, 'tsconfig.json'));
        }
      try {
        watchFile(require.resolve(base));
      } catch {
        // esbuild reports unresolved inherited configs; candidates remain watched for recovery.
      }
    }
  }
  return (initial: string): void => {
    let directory = path.resolve(initial);
    for (;;) {
      watchFile(path.join(directory, 'tsconfig.json'));
      watchFile(path.join(directory, 'jsconfig.json'));
      const parent = path.dirname(directory);
      if (parent === directory) return;
      directory = parent;
    }
  };
}
