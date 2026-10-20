import type { Plugin, ResolveIdResult } from 'rolldown';

import { jsLiteral } from './codegen.ts';
import { WASM_ENTRY_MODULE } from './wasm.ts';

/** The app bundle's name in the Function, which the runtime resolves `arkor:app` to. */
export const APP_MODULE = 'app.cjs';

const EMPTY_EDGE_MODULE = 'export default { entries: {} };';
const EMPTY_WASM_MODULE = '// This deployment carries no WebAssembly.';
/**
 * A build told of no cache host: the runtime asks, is answered nothing, and runs as it did
 * before any cache existed. An export rather than an empty module, because the runtime imports
 * the name and a bundler must find it.
 *
 * The one name, and not the blob reader a host may also export (`unshippedOutputs`): the runtime
 * reads that one off a namespace import, which is `undefined` for a module that does not export it
 * — and a build with no cache host reads no blob of its own bundle from anywhere either. The bundler
 * says so (`IMPORT_IS_UNDEFINED`) and bundles it; the runtime's bundle keeps that to itself.
 */
const NO_CACHE_HOST_MODULE = 'export function createCacheHost() { return undefined; }';

/** The generated modules' own ids: no file is read for them. */
const EDGE_STUB = '\0arkor:edge';
const WASM_STUB = '\0arkor:wasm';
const CACHE_HOST_STUB = '\0arkor:cache-host';
const REQUIRED_CACHE_HOST = '\0arkor:cache-host-with-blob-reader';
const READER_EXPORT_ERROR =
  '@stayingupwind/adapter: unshippedPrerenderBodies requires a statically named ESM createBundleBlobReader export from cacheHostModule';

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
  requireBundleBlobReader?: boolean | undefined;
}): Plugin {
  const required = has.requireBundleBlobReader === true;
  let resolvedHost: string | undefined;
  const resolved: Readonly<Record<string, ResolveIdResult>> = {
    'arkor:app': { id: `./${has.modules.app}`, external: true },
    'arkor:edge': has.edge ? { id: `./${has.modules.edge}`, external: true } : EDGE_STUB,
    'arkor:wasm': has.wasm ? { id: `./${WASM_ENTRY_MODULE}`, external: true } : WASM_STUB,
    'arkor:cache-host': required ? REQUIRED_CACHE_HOST : (has.cacheHostModule ?? CACHE_HOST_STUB),
  };
  const stubs: Readonly<Record<string, string>> = {
    [EDGE_STUB]: EMPTY_EDGE_MODULE,
    [WASM_STUB]: EMPTY_WASM_MODULE,
    [CACHE_HOST_STUB]: NO_CACHE_HOST_MODULE,
  };
  return {
    name: 'arkor-generated-modules',
    async resolveId(source, importer, options) {
      if (importer === REQUIRED_CACHE_HOST && source === has.cacheHostModule) {
        // eslint-disable-next-line unicorn/no-this-outside-of-class -- Rolldown supplies its plugin context as `this`.
        const host = await this.resolve(source, undefined, { ...options, skipSelf: true });
        if (host?.external !== false) throw new Error(READER_EXPORT_ERROR);
        resolvedHost = host.id;
        return host;
      }
      return Object.hasOwn(resolved, source) ? resolved[source] : null;
    },
    load(id) {
      if (id === REQUIRED_CACHE_HOST) {
        if (has.cacheHostModule === undefined) throw new Error(READER_EXPORT_ERROR);
        const host = jsLiteral(has.cacheHostModule);
        // A real named reexport lets the bundler own aliases, star exports and missing names.
        // The host is parsed and linked; none of its top-level code is evaluated by this check.
        return `export * from ${host};export { createBundleBlobReader } from ${host};`;
      }
      return Object.hasOwn(stubs, id) ? stubs[id] : null;
    },
    buildEnd(error) {
      if (error !== undefined || !required) return;
      if (resolvedHost === undefined) throw new Error(READER_EXPORT_ERROR);
      // eslint-disable-next-line unicorn/no-this-outside-of-class -- Rolldown supplies its parsed module information here.
      const host = this.getModuleInfo(resolvedHost);
      if (host?.inputFormat !== 'es') throw new Error(READER_EXPORT_ERROR);
    },
  };
}
