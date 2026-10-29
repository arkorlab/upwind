import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'sdk',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/workers/**'],
  },
});
