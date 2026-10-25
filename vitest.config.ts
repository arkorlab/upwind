import { existsSync, globSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * A suite is run only by the project of the package or tool that keeps it, named by that package's
 * own `vitest.config.mts`, and every project here reads the `.test.ts` files under its `test`
 * directory. A package whose suites need `workerd` and the rest Node keeps the first under
 * `test/workers`, run by its `vitest.workers.config.mts` and by that alone. A suite kept anywhere
 * else, or under another name — `.spec.ts`, `.test.mts` — would never run, and `pnpm test` would
 * pass without it; so a suite like that stops the run, naming itself and where it should be.
 */
function suitesNoProjectRuns(root: string): string[] {
  return globSync('{packages,tools}/*/**/*.{test,spec}.{ts,mts,cts,tsx,js,mjs,cjs,jsx}', {
    cwd: root,
    exclude: (name) => name === 'node_modules' || name.endsWith(`${path.sep}node_modules`),
  }).filter((file) => {
    const [scope = '', name = '', ...rest] = file.split(path.sep);
    const conventional = rest[0] === 'test' && file.endsWith('.test.ts');
    const config = rest[1] === 'workers' ? 'vitest.workers.config.mts' : 'vitest.config.mts';
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a package of this repository, as the glob matched it.
    return !conventional || !existsSync(path.join(root, scope, name, config));
  });
}

const orphans = suitesNoProjectRuns(import.meta.dirname);
if (orphans.length > 0) {
  throw new Error(
    `no project runs these suites; keep each as test/**/*.test.ts in a package with a vitest.config.mts, or as test/workers/**/*.test.ts beside a vitest.workers.config.mts: ${orphans.join(', ')}`,
  );
}

/**
 * One runner over every package and tool with suites of its own. Each keeps its environment and
 * pool in the config named here — a Worker's suites run in `workerd`, the rest under Node — and a
 * package without suites has no config to name.
 */
export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.mts',
      'packages/*/vitest.workers.config.mts',
      'packages/cache/vitest.native.config.mts',
      'tools/*/vitest.config.mts',
      'tools/*/vitest.workers.config.mts',
    ],
  },
});
