import type { KnipConfig } from 'knip';

/**
 * Dead-code detection for every workspace package: CI fails on an unused file or an unused
 * dependency.
 *
 * Unused *exports* are not checked, and cannot be. Everything here is a library, and its readers
 * are a host's own code and the suites that drive it — none of which is in this repository. Knip
 * would report every export that only they use, which is most of them.
 */
const config: KnipConfig = {
  exclude: ['exports', 'types', 'nsExports', 'nsTypes'],
  workspaces: {
    // `playwright` is installed and run inside the Next.js checkout the deploy-tests workflow makes,
    // which is not a dependency of this repository and never will be.
    '.': { ignoreBinaries: ['playwright'] },
    'packages/adapter': {},
    // Three entry points, and `exports` names the `dist` they are built into — the same arrangement
    // as the SDK below, and named here for the same reason.
    'packages/auth': { entry: ['src/{index,next,client}.ts'] },
    'packages/core': {},
    // `templates/` is what this package copies, not what it runs: files nothing imports, on purpose.
    'packages/create-upwind': { ignore: ['templates/**'] },
    // `arkor:*` are the modules the adapter generates beside the runtime and resolves for it;
    // `cloudflare:*` are the Workers runtime's own. Neither is an npm package.
    'packages/runtime': { ignoreDependencies: ['cloudflare', 'arkor'] },
    // Four entry points, and `exports` names the `dist` they are built into — so the sources behind
    // them are named here rather than looked for through files this has not built.
    'packages/sdk': { entry: ['src/{index,db,kv,blob}.ts'] },
    // Reached by path rather than by import: it is the module `upwind build` tells the processes
    // below it to `--import`, so nothing in this repository imports it and `bin` does not lead there.
    'packages/upwind': { entry: ['src/resources/entry.ts'] },
    // The readers are started as child processes by path, so nothing here imports them.
    'tools/deploy-tests': { entry: ['src/read-env.ts', 'src/read-suite-env.ts'] },
    'tools/next-matrix': {},
  },
  // Applications the matrix builds with a Next.js of their own, not code of this repository's — and
  // the site, which is an application too: its own project, its own lockfile, and its own install of
  // the published packages, none of which this workspace's dependency graph knows anything about.
  ignore: ['fixtures/**', 'web-site/**'],
};

export default config;
