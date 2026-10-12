import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'vocabulary',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
