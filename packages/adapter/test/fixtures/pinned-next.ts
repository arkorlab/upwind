import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * `next/<path>` in the published next@16.4.3, as a file path. The native Node path qualifies that
 * release's bytes alone, and the suites install it beside the catalog's Next.js as `next-16-4-3`.
 */
export function resolvePinnedNext(specifier: string): string {
  return require.resolve(specifier.replace(/^next\//u, 'next-16-4-3/'));
}

/** The published next@16.4.3 `package.json`, byte for byte, for a package root a suite builds. */
export const PINNED_NEXT_PACKAGE_JSON = readFileSync(resolvePinnedNext('next/package.json'));
