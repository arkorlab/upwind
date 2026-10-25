import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'native-cache',
    environment: 'node',
    include: ['test/native/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
