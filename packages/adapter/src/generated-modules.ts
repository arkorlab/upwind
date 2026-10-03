import type { Plugin } from 'esbuild';

import { WASM_ENTRY_MODULE } from './wasm.ts';

/** The app bundle's name in the Function, which the runtime resolves `arkor:app` to. */
export const APP_MODULE = 'app.cjs';

const EMPTY_EDGE_MODULE = 'module.exports = { entries: {} };';
const EMPTY_WASM_MODULE = '// This deployment carries no WebAssembly.';
/**
 * A build told of no cache host: the runtime asks, is answered nothing, and runs as it did
 * before any cache existed. An export rather than an empty module, because the runtime imports
 * the name and a bundler must find it.
 *
 * The one name, and not the blob reader a host may also export (`unshippedOutputs`): the runtime
 * reads that one off a namespace import, which is `undefined` for a module that does not export it
 * — and a build with no cache host reads no blob of its own bundle from anywhere either. esbuild
 * says so as a warning and bundles it (`logLevel: 'silent'` here keeps the warning to itself).
 */
const NO_CACHE_HOST_MODULE = 'export function createCacheHost() { return undefined; }';

/**
 * The generated modules the runtime source names: `arkor:app` is the `app.cjs` next to it in
 * the Function, `arkor:edge` the `edge.cjs` — which a deployment with no edge entrypoint does
 * not have, and whose import is then the empty table above rather than a module the Function would
 * carry and never use — and `arkor:wasm` the `wasm.mjs` that publishes the compiled
 * WebAssembly, which a deployment with none does not have either.
 *
 * `arkor:cache-host` is the one module of the four that comes from outside the build:
 * `cacheHostModule` names what the runtime's cache reads and writes through, and it is bundled
 * into the runtime rather than shipped beside it, since it is source like the rest of the
 * runtime. A build told of none resolves to the stub above.
 */
export function generatedModulesPlugin(has: {
  /** The names this Function's code is uploaded under (`codeModules`): `app.cjs`, or `app-2.cjs`. */
  modules: { readonly app: string; readonly edge: string };
  edge: boolean;
  wasm: boolean;
  cacheHostModule: string | undefined;
}): Plugin {
  return {
    name: 'arkor-generated-modules',
    setup(bundler) {
      // eslint-disable-next-line require-unicode-regexp -- an esbuild filter is a Go regular expression
      bundler.onResolve({ filter: /^arkor:app$/ }, () => {
        return {
          path: `./${has.modules.app}`,
          external: true,
        };
      });
      // eslint-disable-next-line require-unicode-regexp -- an esbuild filter is a Go regular expression
      bundler.onResolve({ filter: /^arkor:edge$/ }, () => {
        return has.edge
          ? { path: `./${has.modules.edge}`, external: true }
          : { path: 'arkor:edge', namespace: 'arkor-edge' };
      });
      bundler.onLoad(
        // eslint-disable-next-line require-unicode-regexp -- an esbuild filter is a Go regular expression
        { filter: /^arkor:edge$/, namespace: 'arkor-edge' },
        () => ({ contents: EMPTY_EDGE_MODULE, loader: 'js' }),
      );
      // eslint-disable-next-line require-unicode-regexp -- an esbuild filter is a Go regular expression
      bundler.onResolve({ filter: /^arkor:wasm$/ }, () => {
        return has.wasm
          ? { path: `./${WASM_ENTRY_MODULE}`, external: true }
          : { path: 'arkor:wasm', namespace: 'arkor-wasm' };
      });
      bundler.onLoad(
        // eslint-disable-next-line require-unicode-regexp -- an esbuild filter is a Go regular expression
        { filter: /^arkor:wasm$/, namespace: 'arkor-wasm' },
        () => ({ contents: EMPTY_WASM_MODULE, loader: 'js' }),
      );
      // eslint-disable-next-line require-unicode-regexp -- an esbuild filter is a Go regular expression
      bundler.onResolve({ filter: /^arkor:cache-host$/ }, () => {
        return has.cacheHostModule === undefined
          ? { path: 'arkor:cache-host', namespace: 'arkor-cache-host' }
          : { path: has.cacheHostModule };
      });
      bundler.onLoad(
        // eslint-disable-next-line require-unicode-regexp -- an esbuild filter is a Go regular expression
        { filter: /^arkor:cache-host$/, namespace: 'arkor-cache-host' },
        () => ({ contents: NO_CACHE_HOST_MODULE, loader: 'js' }),
      );
    },
  };
}
