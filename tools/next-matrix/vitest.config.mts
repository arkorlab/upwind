import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'next-matrix', environment: 'node', include: ['test/**/*.test.ts'] },
});
