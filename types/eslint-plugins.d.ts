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
