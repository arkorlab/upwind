import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { type CacheHostSource, sha256Of } from './shipped.ts';

/**
 * The runtime cache's Function host, where a project's build can bundle it into every Function.
 *
 * The host speaks to the runtime the Function runs — it hands the runtime its cache, and the
 * runtime holds its own `fetch` from the moment it loads — so it has to be built against the
 * runtime the Function has, one copy of it, not a copy of its own. The shipped host leaves the
 * runtime and the core out (`scripts/workers.ts`), and before a build names it, those imports are
 * pointed at the files the project's own adapter resolves them to: the runtime the build bundles
 * into the Function is then the one the host was bundled against.
 *
 * Written into the project, under `.upwind/`, which a project keeps out of its repository already;
 * from the sources, the host is the cache package's own module, and named as it is.
 */

/** What the shipped host leaves for the build to resolve: the runtime and the core, and their parts. */
const SHARED_SPECIFIER = /(["'])(@stayingupwind\/(?:core|runtime)(?:\/[\w.-]+)*)\1/gu;

/** Where the host is written for the project's build. */
export const CACHE_HOST_FILE = '.upwind/deploy/cache-host.mjs';

/** The module the project's build names as its cache host. */
export async function cacheHostModuleFor(
  source: CacheHostSource,
  projectDir: string,
  adapterPath: string,
): Promise<string> {
  if (source.kind === 'source') {
    return source.path;
  }
  const shipped = await readFile(source.path, 'utf8');
  if (sha256Of(shipped) !== source.sha256) {
    throw new Error(
      `the shipped cache host (${source.path}) is not the one its manifest names; reinstall upwind`,
    );
  }
  const require = createRequire(adapterPath);
  const unresolved: string[] = [];
  const text = shipped.replaceAll(SHARED_SPECIFIER, (whole, quote: string, specifier: string) => {
    try {
      const resolved = require.resolve(specifier).split(path.sep).join('/');
      return `${quote}${resolved}${quote}`;
    } catch {
      unresolved.push(specifier);
      return whole;
    }
  });
  if (unresolved.length > 0) {
    throw new Error(
      `the project's adapter (${adapterPath}) resolves none of ${[...new Set(unresolved)].join(', ')}; install matching upwind packages`,
    );
  }
  const file = path.join(projectDir, CACHE_HOST_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}
