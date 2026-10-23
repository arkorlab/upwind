import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'upwind',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Some suites run the shipped Workers under Miniflare, which bundles them and starts workerd
    // before the first answer: seconds on a busy machine, and past the default 5 s there.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
