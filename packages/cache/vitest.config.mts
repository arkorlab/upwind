import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * The newest compatibility date the workerd bundled with the installed Miniflare accepts; nothing
 * the cache relies on changed since.
 */
const TEST_COMPATIBILITY_DATE = '2026-09-11';

/** The key the suites' scopes' tokens are signed with: as long as a key must be. */
const CACHE_TOKEN_KEY = 'standalone-cache-token-key-long-enough';

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The standalone cache as a host deploys it: its gateway, its scope object and its entrypoint.
      main: './src/standalone/worker.ts',
      miniflare: {
        compatibilityDate: TEST_COMPATIBILITY_DATE,
        kvNamespaces: ['CACHE_STATE'],
        r2Buckets: ['ARTIFACTS'],
        // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
        durableObjects: { CACHE_SCOPE: { className: 'CacheScope', useSQLite: true } },
        bindings: { CACHE_TOKEN_KEY },
      },
    }),
  ],
  test: {
    name: 'cache',
    include: ['test/**/*.test.ts'],
    exclude: ['test/native/**'],
    // Plugin 1.4.0 cannot read the host's module cache (cloudflare/workers-sdk#16163).
    fsModuleCache: false,
  },
});
