import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'upwind',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
