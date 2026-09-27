// Ambient declarations for ESLint plugins that ship without TypeScript types.
declare module 'eslint-plugin-promise' {
  import type { ESLint, Linter } from 'eslint';

  const plugin: ESLint.Plugin & { configs: Record<'flat/recommended', Linter.Config> };
  export default plugin;
}

declare module 'eslint-plugin-security' {
  import type { ESLint, Linter } from 'eslint';

  const plugin: ESLint.Plugin & { configs: Record<'recommended', Linter.Config> };
  export default plugin;
}

// Ships one config, in the legacy `eslintrc` shape (`plugins: ['redos']`), so the plugin itself is
// what a flat config takes and the rule is named here rather than read off a `configs` entry.
declare module 'eslint-plugin-redos' {
  import type { ESLint } from 'eslint';

  const plugin: ESLint.Plugin;
  export default plugin;
}
