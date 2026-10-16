import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'adapter',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
