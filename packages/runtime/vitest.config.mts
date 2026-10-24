import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // What a build resolves `arkor:cache-host` to, here the function-side host these suites drive
      // the runtime against (`test/function-cache-host.ts`). A suite that wants none mocks it.
      'arkor:cache-host': fileURLToPath(new URL('test/function-cache-host.ts', import.meta.url)),
    },
  },
  test: {
    name: 'runtime',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
