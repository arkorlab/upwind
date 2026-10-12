import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * The newest compatibility date the workerd bundled with the installed Miniflare accepts; nothing
 * the edge relies on changed since.
 */
const TEST_COMPATIBILITY_DATE = '2026-09-11';

/**
 * The hostnames the standalone edge is routed in these suites (`StandaloneEnv.HOSTNAMES`): the
 * site's own, and its `workers.dev` one.
 */
const HOSTNAMES = 'site.example,site-edge.example.workers.dev';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: TEST_COMPATIBILITY_DATE,
        // Live compression reads `node:zlib`, which the Workers runtime has under this flag.
        compatibilityFlags: ['nodejs_compat'],
        kvNamespaces: ['EDGE_STATE', 'CACHE_STATE'],
        r2Buckets: ['ARTIFACTS'],
        bindings: { HOSTNAMES },
      },
    }),
  ],
  test: { name: 'edge', include: ['test/**/*.test.ts'] },
});
