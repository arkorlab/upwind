import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'deploy',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
