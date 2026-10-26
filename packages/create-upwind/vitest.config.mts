import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'create-upwind', environment: 'node', include: ['test/**/*.test.ts'] },
});
