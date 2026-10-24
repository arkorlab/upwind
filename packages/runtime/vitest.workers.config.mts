import { fileURLToPath } from 'node:url';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * The newest compatibility date the workerd bundled with the installed Miniflare accepts, as the
 * edge's suites run at.
 */
const TEST_COMPATIBILITY_DATE = '2026-09-11';

/**
 * The runtime's suites that only `workerd` runs: what reaches `cloudflare:node` or
 * `cloudflare:workers` — the bridge to a Node handler, a deployment's own resources — exists
 * nowhere else. The rest of the runtime's suites run under Node (`vitest.config.mts`).
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: TEST_COMPATIBILITY_DATE,
        // The bridge serves a Node handler through `node:http`, which workerd has under this flag.
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  resolve: {
    alias: {
      // What a build resolves `arkor:cache-host` to, here the function-side host these suites drive
      // the runtime against, as the Node project's do (`test/function-cache-host.ts`).
      'arkor:cache-host': fileURLToPath(new URL('test/function-cache-host.ts', import.meta.url)),
    },
  },
  test: {
    name: 'runtime:workers',
    include: ['test/workers/**/*.test.ts'],
    // Each renders through the runtime and its cache host in workerd, a second or more apiece.
    testTimeout: 60_000,
    // Plugin 1.4.0 cannot read the host's module cache (cloudflare/workers-sdk#16163).
    fsModuleCache: false,
  },
});
