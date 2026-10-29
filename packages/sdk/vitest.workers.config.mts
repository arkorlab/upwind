import { createRequire } from 'node:module';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const socketParser = createRequire(require.resolve('socket.io')).resolve('socket.io-parser');

export default defineConfig({
  resolve: {
    // The bridge exercises Node's ws package, not its browser-only client placeholder.
    alias: [
      { find: /^ws$/u, replacement: require.resolve('ws') },
      {
        find: /^engine\.io-parser$/u,
        replacement: createRequire(require.resolve('engine.io')).resolve('engine.io-parser'),
      },
      {
        find: /^socket\.io-parser$/u,
        replacement: socketParser,
      },
      {
        find: /^@socket\.io\/component-emitter$/u,
        replacement: createRequire(socketParser).resolve('@socket.io/component-emitter'),
      },
    ],
  },
  plugins: [
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
