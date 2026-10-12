import { existsSync, globSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * A suite is run only by the project of the package or tool that keeps it, named by that package's
 * own `vitest.config.mts`. One kept where there is no such config would never run, and `pnpm test`
 * would pass without it — so a suite like that stops the run, naming itself.
 */
function suitesNoProjectRuns(root: string): string[] {
  return globSync('{packages,tools}/*/**/*.{test,spec}.{ts,mts,cts,tsx,js,mjs,cjs,jsx}', {
    cwd: root,
    exclude: (name) => name === 'node_modules' || name.endsWith(`${path.sep}node_modules`),
  }).filter((file) => {
    const [scope = '', name = ''] = file.split(path.sep);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a package of this repository, as the glob matched it.
    return !existsSync(path.join(root, scope, name, 'vitest.config.mts'));
  });
}

const orphans = suitesNoProjectRuns(import.meta.dirname);
if (orphans.length > 0) {
  throw new Error(
    `no project runs these suites; give their package a vitest.config.mts: ${orphans.join(', ')}`,
  );
}

/**
 * One runner over every package and tool with suites of its own. Each keeps its environment and
 * pool in the config named here — a Worker's suites run in `workerd`, the rest under Node — and a
 * package without suites has no config to name.
 */
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.mts', 'tools/*/vitest.config.mts'],
  },
});
