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
    '.': {},
    'packages/adapter': {},
    'packages/core': {},
    // `ppr-cdn:*` are the modules the adapter generates beside the runtime and resolves for it;
    // `cloudflare:*` are the Workers runtime's own. Neither is an npm package.
    'packages/runtime': { ignoreDependencies: ['cloudflare', 'ppr-cdn'] },
    'packages/upwind': {},
  },
};

export default config;
