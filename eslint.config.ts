import { builtinModules } from 'node:module';

import js from '@eslint/js';
import type { Linter } from 'eslint';
import prettierConfig from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import nodePlugin from 'eslint-plugin-n';
import perfectionist from 'eslint-plugin-perfectionist';
import promisePlugin from 'eslint-plugin-promise';
import regexp from 'eslint-plugin-regexp';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Everything on, then a short and justified opt-out list. Type-aware throughout: the rules that
 * catch the mistakes worth catching all need types.
 */

/** The two commands a developer runs: one in front of a dev server, one that writes a project. */
const CLI_FILES = ['packages/upwind/**/*.ts', 'packages/create-upwind/**/*.ts'];
/**
 * The adapter runs under Node inside `next build`, and the CLIs are Node processes of their own; the
 * runtime runs in a Function, where `nodejs_compat` gives it the Node built-ins it does use.
 */
const NODE_ONLY_FILES = [
  'packages/adapter/**/*.ts',
  ...CLI_FILES,
  'packages/sdk/scripts/**/*.ts',
  'tools/**/*.ts',
  '*.config.ts',
  '**/*.config.ts',
];
/**
 * What has to hold wherever it is evaluated, so it can be read by both of the above — and, for the
 * SDK, by an application, which is a Function as often as it is a development server.
 */
const RUNTIME_NEUTRAL_FILES = ['packages/core/**/*.ts', 'packages/sdk/src/**/*.ts'];

/**
 * Plugin `configs` maps are index signatures typed as unions of legacy and flat shapes; resolve one
 * flat-config entry or fail loudly at load time. The cast is the single typed boundary to plugins.
 */
function configOf(configs: Record<string, unknown> | undefined, name: string): Linter.Config {
  const config = configs?.[name];
  if (config === undefined) {
    throw new Error(`ESLint plugin config "${name}" is missing.`);
  }
  return config as Linter.Config;
}

const NODE_BUILTINS = builtinModules.flatMap((name) =>
  name.startsWith('_') ? [] : [name, `node:${name}`],
);

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/.ppr-cdn/**',
    // An application this repository writes for somebody else, not one it runs: it is held to the
    // conventions of a Next.js project, which are not these.
    'packages/create-upwind/templates/**',
    // Applications `tools/next-matrix` builds with a Next.js of their own. They are input to a
    // build, not code of this repository's: what they may say is Next.js's to decide, and a
    // `"use cache"` directive or a `?module` import is not this configuration's business.
    'fixtures/**',
  ]),

  // 1. Base JavaScript rules: everything on, then a short, justified opt-out list.
  {
    files: ['**/*.{ts,tsx,mts}'],
    ...js.configs.all,
  },
  {
    files: ['**/*.{ts,tsx,mts}'],
    rules: {
      camelcase: 'off', // `@typescript-eslint/naming-convention` owns naming; external field names (Sentry) stay as-is
      'capitalized-comments': 'off', // comments quote identifiers and URLs
      'class-methods-use-this': 'off', // Function/Durable Object handlers are shape-driven
      'consistent-return': 'off', // TypeScript `noImplicitReturns` covers this precisely
      'default-case': 'off', // `@typescript-eslint/switch-exhaustiveness-check` is stricter
      'func-style': ['error', 'declaration', { allowArrowFunctions: true }],
      'id-length': 'off', // short names are fine for indices and callbacks
      'init-declarations': 'off', // `let` without initializer is idiomatic for streaming state
      'max-classes-per-file': ['error', 3], // Function entry files export several classes
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': 'off', // sonarjs cognitive complexity is the better signal
      'max-params': ['error', 4],
      'max-statements': 'off', // sonarjs cognitive complexity is the better signal
      'no-await-in-loop': 'off', // sequential origin requests are intentional in the prover
      'no-console': 'error',
      'no-continue': 'off',
      'no-duplicate-imports': 'off', // import-x/no-duplicates handles type-only imports correctly
      'require-atomic-updates': 'off', // false positives on sequential awaits in stream loops
      'no-inline-comments': 'off',
      'no-magic-numbers': 'off', // replaced by the TypeScript-aware variant below
      'no-negated-condition': 'off', // stylistic; unicorn owns the useful cases
      'no-plusplus': ['error', { allowForLoopAfterthoughts: true }],
      'no-shadow': 'off', // replaced by the TypeScript-aware variant below
      'no-ternary': 'off',
      'no-undefined': 'off', // `undefined` is the idiomatic "absent" value with exactOptionalPropertyTypes
      'no-underscore-dangle': 'off', // Next.js internals (`__next_f`, `_rsc`) appear in string constants
      'no-use-before-define': 'off', // replaced by the TypeScript-aware variant below
      'no-void': ['error', { allowAsStatement: true }],
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'anywhere' }],
      'one-var': 'off',
      'prefer-destructuring': 'off',
      'prefer-named-capture-group': 'off', // regexp plugin governs regex quality
      'arrow-body-style': 'off', // unicorn/consistent-arrow-return-style is the single source of truth
      'sort-imports': 'off', // oxfmt sorts imports
      'sort-keys': 'off', // perfectionist sorts objects where it matters
    },
  },

  // 2. TypeScript: strict + stylistic, type-aware, with extra rigor.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    // Plain JavaScript config files (e.g. postcss.config.mjs) get no type-aware rules.
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports', prefer: 'type-imports' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE', 'PascalCase'] },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'parameter', format: ['camelCase', 'PascalCase'], leadingUnderscore: 'allow' },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['PascalCase'] },
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
        { selector: ['objectLiteralProperty', 'typeProperty', 'classProperty'], format: null },
      ],
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/no-restricted-types': [
        'error',
        {
          types: {
            '{}': { message: 'Use a precise object type or `Record<string, never>`.' },
            object: { message: 'Use a precise object type or `Record<string, unknown>`.' },
          },
        },
      ],
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-use-before-define': [
        'error',
        { functions: false, typedefs: false, ignoreTypeReferences: true },
      ],
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use string literal unions instead of enums.' },
        {
          selector: 'TSParameterProperty',
          message: 'Parameter properties are not erasable syntax; declare fields explicitly.',
        },
        {
          selector: 'ExportDefaultDeclaration > ArrowFunctionExpression',
          message: 'Default-export a named function declaration, not an arrow function.',
        },
      ],
    },
  },

  // 3. Cross-plugin quality layers.
  configOf(unicorn.configs, 'all'),
  configOf(sonarjs.configs, 'recommended'),
  configOf(security.configs, 'recommended'),
  configOf(regexp.configs, 'flat/recommended'),
  configOf(promisePlugin.configs, 'flat/recommended'),
  configOf(perfectionist.configs, 'recommended-natural'),
  {
    files: ['**/*.{ts,tsx,mts}'],
    rules: {
      // Alphabetical ordering of declarations, object literals and type members destroys
      // semantic grouping; perfectionist is kept for collections where order carries no meaning.
      'perfectionist/sort-classes': 'off',
      'perfectionist/sort-exports': 'off', // oxfmt owns import/export order
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-interfaces': 'off',
      'perfectionist/sort-jsx-props': 'off',
      'perfectionist/sort-modules': 'off',
      'perfectionist/sort-named-exports': 'off',
      'perfectionist/sort-named-imports': 'off',
      'perfectionist/sort-object-types': 'off',
      'perfectionist/sort-objects': 'off',
      'perfectionist/sort-union-types': 'off',
      'promise/no-multiple-resolved': 'error',
      'promise/no-nesting': 'error',
      'sonarjs/cognitive-complexity': ['error', 15],
      'sonarjs/no-duplicate-string': 'error',
      'sonarjs/no-identical-functions': 'error',
      'unicorn/filename-case': [
        'error',
        { case: 'kebabCase', ignore: [/^\[.*\]/u, /^_/u, /\.d\.ts$/u] },
      ],
      'perfectionist/sort-switch-case': 'off', // case order follows the protocol, not the alphabet
      'security/detect-object-injection': 'off', // flags every computed access; TypeScript covers it
      'security/detect-unsafe-regex': 'off', // false positives on bounded quantifiers; regexp/no-super-linear-backtracking is precise
      'unicorn/comment-content': 'off', // prose casing in comments is not a code-quality signal
      'unicorn/no-break-in-nested-loop': 'off', // `switch` inside parser loops is idiomatic
      'unicorn/no-non-function-verb-prefix': 'off', // zod schema names such as `createSiteRequestSchema` are nouns
      'unicorn/prefer-iterator-to-array': 'off', // `Iterator#toArray` is not in the TypeScript 5.9 lib
      'unicorn/prefer-number-coercion': 'off', // `parseInt` with an explicit radix is intentional for tolerant header parsing
      'unicorn/consistent-boolean-name': 'off', // rejects idiomatic predicates (`startsWith`, `equals`)
      'unicorn/import-style': 'off',
      'unicorn/name-replacements': 'off', // dictionary renames conflict with Next.js/Workers conventions (ctx, params)
      'unicorn/no-array-front-mutation': 'off', // queues are FIFO by definition
      'unicorn/no-asterisk-prefix-in-documentation-comments': 'off', // standard JSDoc style
      'unicorn/no-await-expression-member': 'off',
      'unicorn/no-barrel-files': 'off', // package subpath entry points are barrels by design
      'unicorn/no-null': 'off', // React and Next.js APIs return `null`
      'unicorn/no-unreadable-new-expression': 'off', // `new URL(x).host` is idiomatic
      'unicorn/prefer-error-is-error': 'off', // `Error.isError` is not in the TypeScript 5.9 lib
      'unicorn/prefer-uint8array-base64': 'off', // `Uint8Array#toBase64` is not in the TypeScript 5.9 lib
      'unicorn/single-line-block-comment-style': 'off', // single-line JSDoc is idiomatic
      'unicorn/try-complexity': 'off', // a complexity budget of 1 per try block is unworkable for stream pumps
      'unicorn/prefer-top-level-await': 'off', // not valid in Next.js modules
      'unicorn/prevent-abbreviations': 'off', // Next.js conventions (`props`, `params`, `env`, `ref`)
    },
  },

  // 3b. Import hygiene (import-x is ESLint 10 compatible; eslint-plugin-import is not).
  {
    files: ['**/*.{ts,tsx,mts}'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
    },
    rules: {
      'import-x/no-anonymous-default-export': 'error',
      'import-x/no-cycle': 'error',
      'import-x/no-default-export': 'error',
      'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': ['error', { noUselessIndex: true }],
    },
  },

  // The adapter writes the bundle and says what it did while `next build` runs.
  {
    files: ['packages/adapter/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // The adapter reads and writes the build output Next.js hands it, on a Node version without
    // Temporal, so every path it touches comes from that output rather than from a literal.
    files: ['packages/adapter/**/*.ts'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
      'unicorn/prefer-temporal': 'off',
    },
  },
  {
    files: ['*.config.ts', '**/*.config.{ts,mts}', 'eslint.config.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      'import-x/no-default-export': 'off',
      'max-lines': 'off',
      'sonarjs/no-duplicate-string': 'off',
    },
  },
  {
    files: ['**/*.d.ts'],
    rules: { 'import-x/no-default-export': 'off' },
  },

  // Node-only files: the adapter, and this repository's own configuration.
  {
    files: NODE_ONLY_FILES,
    ...configOf(nodePlugin.configs, 'flat/recommended-module'),
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: NODE_ONLY_FILES,
    rules: {
      'n/no-missing-import': 'off', // TypeScript resolves these
      'n/no-process-env': 'off',
      'n/no-unpublished-import': 'off',
    },
  },

  // A CLI is a program a developer runs, and it says so on the terminal it was run from.
  // The paths it reads and writes are the ones under the project it was pointed at.
  // It ends the process with the code something else reads back: `upwind dev`'s supervisor, or
  // whoever started `create-upwind` and the install it ran.
  // A restart is an exit code rather than an exception, because Next.js's dev tooling exits from inside.
  //
  // After the Node-only config above, which is what turns `n/no-process-exit` on: in a flat config
  // the later entry decides.
  {
    files: CLI_FILES,
    rules: {
      'n/no-process-exit': 'off',
      'no-console': 'off',
      'security/detect-child-process': 'off', // the commands are this program's own names, never a user's
      'security/detect-non-literal-fs-filename': 'off',
      // `git` and `pnpm` are reached the way a developer reaches them, through their own PATH. An
      // absolute path would run something other than the tool they use.
      'sonarjs/no-os-command-from-path': 'off',
      'unicorn/no-process-exit': 'off',
      'unicorn/prefer-temporal': 'off', // the Node version this runs on has no Temporal
    },
  },

  // The tools are programs a maintainer runs, and what they have to say is the whole of their
  // output. The paths they touch are under a directory they made themselves, or under a package
  // they just fetched — neither is a literal anyone could have written here.
  {
    files: ['tools/**/*.ts'],
    rules: {
      'no-console': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },

  // A build script is the same kind of program: it says what it produced, and the only paths it
  // touches are the ones it is about to write, under its own package.
  {
    files: ['packages/sdk/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      'security/detect-child-process': 'off', // `tsc`, resolved from this package's own install
      'security/detect-non-literal-fs-filename': 'off',
    },
  },

  // Three entry points whose whole subject is one value, which is the one they export by default:
  // `import db from '@stayingupwind/sdk/db'` is the line this package exists to make possible, and
  // `import { db }` would be the same word twice.
  {
    files: ['packages/sdk/src/{db,kv,blob}.ts'],
    rules: { 'import-x/no-default-export': 'off' },
  },

  // What both of the others are built on: it must hold wherever it is evaluated.
  {
    files: RUNTIME_NEUTRAL_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => {
            return {
              name,
              message: 'This package must stay runtime-neutral: no Node.js built-in modules.',
            };
          }),
        },
      ],
    },
  },

  // Prettier last: it turns off every stylistic rule the formatter owns.
  prettierConfig,
]);
