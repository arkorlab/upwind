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

/** A real Fetcher boundary for the nonce suite; other suites never call this fixture. */
const GATE_FETCH_FIXTURE = `import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

const HTML = '<html><script nonce="kept">1</script><p>whole tail</p></html>';
export default {
  fetch(request) {
    const coding = request.headers.get('x-test-gate-coding') ?? 'identity';
    const headers = new Headers({
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "script-src 'self' 'nonce-kept'",
      'x-observed-accept-encoding': request.headers.get('accept-encoding') ?? '',
      'x-observed-gate-route': request.headers.get('x-upwind-gate-route') ?? '',
      etag: '"saved"',
    });
    if (coding !== 'identity') headers.set('content-encoding', coding);
    const bytes = new TextEncoder().encode(HTML);
    if (coding === 'deflate') {
      return new Response(Uint8Array.from(deflateSync(bytes)), { headers, encodeBody: 'manual' });
    }
    if (coding === 'gzip, br') {
      return new Response(Uint8Array.from(brotliCompressSync(gzipSync(bytes))), {
        headers,
        encodeBody: 'manual',
      });
    }
    // Real Worker egress encodes gzip/br; its Fetcher caller supplies decoded JS bytes.
    // Ignore identity deliberately: a gate may still return its saved compressed document.
    return new Response(HTML, { headers, encodeBody: 'automatic' });
  },
};
`;

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
        serviceBindings: { GATE_NONCE_FETCH: 'gate-nonce-body-origin' },
        workers: [
          {
            name: 'gate-nonce-body-origin',
            modules: true,
            script: GATE_FETCH_FIXTURE,
            compatibilityDate: TEST_COMPATIBILITY_DATE,
            compatibilityFlags: ['nodejs_compat'],
          },
        ],
      },
    }),
  ],
  test: {
    name: 'edge',
    include: ['test/**/*.test.ts'],
    // Plugin 1.4.0 cannot read the host's module cache (cloudflare/workers-sdk#16163).
    fsModuleCache: false,
  },
});
