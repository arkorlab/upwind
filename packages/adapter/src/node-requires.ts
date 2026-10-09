import { builtinModules } from 'node:module';

import type { Plugin } from 'esbuild';

import { jsLiteral } from './codegen.ts';

export const NODE_BUILTIN_NAMESPACE = 'upwind-node-builtin';
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));

/** CommonJS built-in loads become native ESM imports, without a global require shim. */
export function nodeBuiltinRequires(): Plugin {
  return {
    name: NODE_BUILTIN_NAMESPACE,
    setup(builder) {
      // eslint-disable-next-line require-unicode-regexp -- esbuild filters are Go regular expressions.
      builder.onResolve({ filter: /^(?:node:)?[a-z_]/ }, (args) => {
        const name = args.path.replace(/^node:/u, '');
        return args.kind === 'require-call' && BUILTINS.has(name)
          ? { path: `node:${name}`, namespace: NODE_BUILTIN_NAMESPACE }
          : undefined;
      });
      // eslint-disable-next-line require-unicode-regexp -- esbuild filters are Go regular expressions.
      builder.onLoad({ filter: /.*/, namespace: NODE_BUILTIN_NAMESPACE }, (args) => {
        return {
          contents: `import binding from ${jsLiteral(args.path)}; module.exports = binding;`,
          loader: 'js',
        };
      });
    },
  };
}
