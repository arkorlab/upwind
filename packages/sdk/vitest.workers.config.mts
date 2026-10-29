import { builtinModules, createRequire } from 'node:module';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { rolldown } from 'rolldown';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const nodeWebSocket = require.resolve('ws');
const SERVER_PREFIX = '\0upwind:test-websocket-server:';
const SERVERS = new Map([
  ['engine.io', require.resolve('engine.io')],
  ['socket.io', require.resolve('socket.io')],
]);

/** Bundle the real servers as an application does, before workerd's test-only CJS fallback. */
async function bundledServer(entry: string): Promise<string> {
  const wrapper = '\0upwind:test-websocket-server-entry';
  await using bundle = await rolldown({
    input: wrapper,
    platform: 'node',
    external: [...builtinModules, /^node:/u],
    plugins: [
      {
        name: 'websocket-server-entry',
        resolveId(id) {
          if (id === wrapper) return { id };
          return id === 'ws' ? { id: nodeWebSocket, external: true } : null;
        },
        load: (id) => (id === wrapper ? `export { Server } from ${JSON.stringify(entry)};` : null),
      },
    ],
  });
  const { output } = await bundle.generate({ format: 'esm' });
  const chunk = output.find((item) => item.type === 'chunk' && item.isEntry);
  if (chunk?.type !== 'chunk') throw new Error('WebSocket server dependency did not bundle');
  return chunk.code;
}

export default defineConfig({
  resolve: {
    // The bridge exercises Node's ws package, not its browser-only client placeholder.
    alias: [{ find: /^ws$/u, replacement: nodeWebSocket }],
  },
  plugins: [
    {
      name: 'bundle-websocket-test-servers',
      enforce: 'pre',
      resolveId: (id) => (SERVERS.has(id) ? `${SERVER_PREFIX}${id}` : null),
      async load(id) {
        if (!id.startsWith(SERVER_PREFIX)) return null;
        const entry = SERVERS.get(id.slice(SERVER_PREFIX.length));
        return entry === undefined ? null : bundledServer(entry);
      },
    },
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-09-11',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    name: 'sdk:workers',
    include: ['test/workers/**/*.test.ts'],
    fsModuleCache: false,
    env: { WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1' },
  },
});
