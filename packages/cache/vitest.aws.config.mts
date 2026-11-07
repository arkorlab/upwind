import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'aws-cache',
    environment: 'node',
    include: ['test/aws/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
