import { isBuiltin } from 'node:module';

import type { Plugin } from 'rolldown';

import { jsLiteral } from './codegen.ts';

/** The id a `require()` of a built-in is bundled under: no file is read for it. */
const NODE_BUILTIN_PREFIX = '\0upwind-node-builtin:';

/**
 * CommonJS built-in loads become native ESM imports, without a global require shim.
 *
 * A built-in, with or without the `node:` prefix, is left to workerd as `node:<name>`. Where a
 * `require()` asks for it, the call is answered by a module of the bundle's own that imports the
 * built-in and hands it on: the class module then carries an import workerd links, where the call
 * itself would reach for a `require` an ES module does not have.
 */
export function nodeBuiltinRequires(): Plugin {
  return {
    name: 'upwind-node-builtin',
    resolveId: {
      filter: { id: /^(?:node:)?[a-z_]/u },
      handler(source, importer, options) {
        if (!isBuiltin(source)) return null;
        const name = `node:${source.replace(/^node:/u, '')}`;
        if (importer?.startsWith(NODE_BUILTIN_PREFIX) === true || options.kind !== 'require-call')
          return { id: name, external: true };
        return { id: `${NODE_BUILTIN_PREFIX}${name}` };
      },
    },
    load: {
      filter: { id: /^\0upwind-node-builtin:/u },
      handler: (id) => {
        return {
          code: `import binding from ${jsLiteral(id.slice(NODE_BUILTIN_PREFIX.length))}; module.exports = binding;`,
          moduleType: 'js',
        };
      },
    },
  };
}
