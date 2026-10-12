import { defineConfig } from 'vitest/config';

/**
 * One runner over every package and tool with suites of its own. Each keeps its environment and
 * pool in the config named here — a Worker's suites run in `workerd`, the rest under Node — and a
 * package without suites has no config to name.
 */
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.mts', 'tools/*/vitest.config.mts'],
  },
});
