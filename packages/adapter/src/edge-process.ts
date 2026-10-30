import { realpath } from 'node:fs/promises';

import type { Plugin } from 'rolldown';
import { transformSync } from 'rolldown/utils';

import { jsLiteral } from './codegen.ts';

/**
 * The `process` an entrypoint on the edge runtime reads. Next.js evaluates its edge chunks in a
 * sandbox whose `process` has the environment and nothing of Node.js's (`createProcessPolyfill`, in
 * `server/web/sandbox/context.ts`): every other key of the host's `process` reads as `undefined`.
 * Code tells the two runtimes apart by it — `process.version ? 'Node.js' : 'Edge'`
 * (`switchable-runtime`) — and here the chunks share the Function's own `process`, so an edge page
 * said it ran on Node.js, the Function's version and all.
 *
 * The chunks cannot be handed an object of their own in its place: Next.js's edge globals make the
 * `process` a chunk sees the global one wherever the two differ (`enhanceGlobals`, in
 * `server/web/globals.ts`), and this global is the Node.js runtime's, in the same isolate. What
 * changes instead is each read of a Node.js value off the global `process` in a chunk's own code
 * (`process.version`, `process.platform`): it reads the key off a module of this bundle's, which
 * holds none of them, so each reads as `undefined`, and a write to one stays in that module.
 *
 * Only values, and not the functions: those keep reading the Function's own. Next.js's sandbox
 * hands an edge chunk one that throws for each, but the sandbox has a global object of its own, and
 * here the chunks share the Node.js runtime's. What a chunk keeps on it, the Node.js runtime reads:
 * Next.js's immediate scheduler keeps the `process.nextTick` it wraps under
 * `Symbol.for('next.fast-set-immediate.originals')`, made by whichever copy runs first, so a
 * throwing `nextTick` read by an edge page went into every `process.nextTick` call the Node.js
 * routes made after it, and the first one threw out of the process.
 *
 * `process.env` and `process` itself are left as they are, and so is every module that is not one
 * of the chunks: the generated entry, and a host's instrumentation. The replacement is Oxc's
 * define, which leaves a `process` a module binds itself alone. Only a read spelled out is
 * replaced: a computed key (`process['version']`) or a destructuring still reads the Function's
 * `process`. A chunk that reads no Node.js value is not rewritten at all, and nothing is done per
 * request beyond the read itself.
 */

/** The specifier the replacements require, and the module it resolves to. */
const MODULE = 'upwind:edge-process';
const VIRTUAL = `\0${MODULE}`;

/**
 * The host's own enumerable keys but `env` and its functions, as Next.js enumerates them. A key that
 * is an accessor is not read (`stdout` would open the stream), and is a value here.
 */
function nodeOnlyValues(): readonly string[] {
  return Object.keys(process).filter((key) => {
    return (
      key !== 'env' &&
      /^[A-Z_a-z$][\w$]*$/u.test(key) &&
      typeof Object.getOwnPropertyDescriptor(process, key)?.value !== 'function'
    );
  });
}

/** The module the reads are taken to: none of the values, and a place for what a chunk writes. */
const MODULE_SOURCE = "'use strict';\nmodule.exports = {};\n";

function escaped(key: string): string {
  return key.replaceAll('$', String.raw`\$`);
}

async function realOrAsWritten(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return file;
  }
}

/** Give the chunks named the edge runtime's `process`; `chunks`, the files Next.js listed. */
export function edgeProcessPlugin(chunks: readonly string[]): Plugin {
  const keys = nodeOnlyValues();
  const define = Object.fromEntries(
    keys.map((key) => [`process.${key}`, `require(${jsLiteral(MODULE)}).${key}`]),
  );
  // eslint-disable-next-line security/detect-non-literal-regexp -- the keys are escaped identifiers.
  const reads = new RegExp(
    String.raw`\bprocess\s*\.\s*(?:${keys.map((key) => escaped(key)).join('|')})\b`,
    'u',
  );
  let ids = new Set<string>();
  return {
    name: 'upwind-edge-process',
    async buildStart() {
      // Rolldown names a module by its real path; Next.js, by the one it wrote.
      const real = await Promise.all(chunks.map((chunk) => realOrAsWritten(chunk)));
      ids = new Set(chunks);
      for (const file of real) {
        ids.add(file);
      }
    },
    resolveId: (source) => (source === MODULE ? VIRTUAL : null),
    load: (id) => (id === VIRTUAL ? MODULE_SOURCE : null),
    transform: {
      filter: { code: reads },
      handler(code, id) {
        if (!ids.has(id)) {
          return null;
        }
        const result = transformSync(id, code, {
          lang: 'js',
          sourceType: 'commonjs',
          define,
          sourcemap: true,
        });
        const [error] = result.errors;
        if (error !== undefined) {
          throw new Error(
            `@stayingupwind/adapter: could not give ${id} the edge runtime's process: ${error.message}`,
          );
        }
        return { code: result.code, map: result.map ?? null };
      },
    },
  };
}
