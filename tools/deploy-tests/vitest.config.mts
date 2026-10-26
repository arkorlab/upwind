import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'deploy-tests',
    testTimeout: 20_000,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
