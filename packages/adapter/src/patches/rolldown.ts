import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import type { Plugin } from 'rolldown';

import { arkorWasmGlobal, type WasmCollector } from '../wasm.ts';
import { isStubbedModule, NODE_VM_MODULE, stubSourceFor } from './loader-hooks.ts';
import type { Patch, PatchContext, PatchResult } from './types.ts';
import { OTEL_API, VENDORED_OTEL_API } from './vendored-otel.ts';

/**
 * Where the patches meet the bundler. Rolldown loads each file once; a file a patch targets is
 * rewritten as it is loaded, and what the patch reports is handed to `onApplied` for the
 * dependency record. Another bundler would need only another version of this file.
 *
 * More than one patch may claim the same file — one names it, another finds it by what is in it —
 * so they are applied in order and each sees what the one before left. A patch whose `marker`
 * the file does not carry is not applied and is not recorded: it was never for that file.
 */

export interface AppliedPatch {
  readonly patch: string;
  readonly file: string;
  readonly result: PatchResult;
}

export function patchesPlugin(
  patches: readonly Patch[],
  ctx: PatchContext,
  onApplied?: (applied: AppliedPatch) => void,
): Plugin {
  return {
    name: 'arkor-patches',
    load: {
      // Tested against the id with `/` separators, whatever the platform's; so are the targets.
      filter: { id: patches.map((patch) => patch.target) },
      async handler(id) {
        const matching = patches.filter((candidate) => candidate.target.test(id));
        if (matching.length === 0) {
          return null;
        }
        let source = await readFile(id, 'utf8');
        let patched = false;
        for (const patch of matching) {
          if (patch.marker !== undefined && !patch.marker(source)) {
            continue;
          }
          const result = patch.apply(source, id, ctx);
          onApplied?.({ patch: patch.name, file: id, result });
          source = result.contents;
          patched = true;
        }
        return patched ? { code: source, moduleType: 'js' } : null;
      },
    },
  };
}

/** The id a stubbed module is bundled under; what the dependency record lists it as. */
const STUB_ID_PREFIX = 'arkor-stub:';

function stubModule(id: string): { code: string; moduleType: 'js' } {
  return { code: stubSourceFor(id.slice(STUB_ID_PREFIX.length)), moduleType: 'js' };
}

/**
 * Module-loader hooks have nothing to hook in a Function, and resolve to an empty module; an
 * optional module of a feature the platform does not run resolves to one that says so; a module
 * workerd cannot load resolves to the adapter's own copy, and `node:process`, which its `require`
 * does not find, to the global it is (`loader-hooks.ts`). In the workflow Function alone,
 * `node:vm` as the server chunks import it resolves to a module that throws when called.
 */
export function stubPlugin(
  onStubbed?: (specifier: string) => void,
  workflowFunction = false,
): Plugin {
  return {
    name: 'arkor-stubs',
    resolveId: {
      filter: {
        id: /^(?:require|import)-in-the-middle|^critters$|compiled\/raw-body$|^(?:node:)?(?:process|vm)$/u,
      },
      handler(source, importer) {
        if (
          !isStubbedModule(source) &&
          !(workflowFunction && isWorkflowVmImport(source, importer))
        ) {
          return null;
        }
        onStubbed?.(source);
        return `${STUB_ID_PREFIX}${source}`;
      },
    },
    load: {
      filter: { id: /^arkor-stub:/u },
      handler: (id) => stubModule(id),
    },
  };
}

/** A module Turbopack wrote for the server: the application's own code and what it bundled. */
const SERVER_CHUNK = /[/\\]server[/\\]chunks[/\\]/u;

/**
 * `node:vm`, as the server chunks import it — stubbed (`NODE_VM_SOURCE` in `loader-hooks.ts`) in
 * the workflow Function, whose chunks are the Workflow SDK's flow route: the SDK imports it for an
 * engine it does not run there, and calls nothing of it. Only there, and only for those chunks:
 * the application's and the middleware's Functions — where `start()` and the rest of the SDK's
 * client import no `node:vm` — still leave it to the audit, which refuses it, as it refuses
 * Next.js's own modules reaching for it anywhere.
 */
function isWorkflowVmImport(source: string, importer: string | undefined): boolean {
  return importer !== undefined && NODE_VM_MODULE.test(source) && SERVER_CHUNK.test(importer);
}

/**
 * What the bundler leaves to the Function's own resolver: every Node built-in a module asks for,
 * under either spelling, is reported as it is resolved. (Rolldown externalizes them itself for
 * the `node` platform; what it cannot resolve at all it externalizes too, with a log — see
 * `bundleApp` — and the audit refuses.)
 */
export function externalsPlugin(onExternal: (specifier: string) => void): Plugin {
  return {
    name: 'arkor-externals',
    resolveId(source) {
      if (isBuiltin(source)) {
        onExternal(source);
      }
      return null;
    },
  };
}

/** The id a `?module` import is bundled under; what the dependency record lists it as. */
const WASM_ID_PREFIX = 'arkor-wasm:';
/** The suffix that asks for the compiled module rather than an instantiated one. */
const MODULE_QUERY = '?module';

/**
 * A `?module` import of a `.wasm` that the app bundler is asked to resolve itself.
 *
 * Turbopack's own imports never reach here — it emits its `.wasm` next to its chunks and its
 * loader asks for them by path, which is the `wasm-loader` patch's business. This is for a
 * package bundled from `node_modules` that writes the import Vercel's edge runtime documents,
 * `import m from './x.wasm?module'`: `@vercel/og`'s edge build, which Next.js ships, is the one
 * at hand. The module becomes a read of the global the Function publishes, so the bytes travel as
 * a compiled module rather than as a string in the bundle.
 *
 * Only `?module` is claimed. The suffix is what says "give me the compiled module and do not
 * instantiate it", which is exactly what the global holds; a bare `import { f } from './x.wasm'`
 * asks to be instantiated and to re-export what the module exports, and answering it with a
 * `WebAssembly.Module` would build cleanly and then fail on the first call of `f`.
 *
 * A `.wasm` no trace offered fails the build: shipping a module the Function does not carry would
 * leave the global undefined, and the route would fail on its first request instead.
 */
export function wasmModulePlugin(
  wasm: WasmCollector,
  onResolved?: (file: string, global: string) => void,
): Plugin {
  return {
    name: 'arkor-wasm-modules',
    resolveId: {
      filter: { id: /\.wasm\?module$/u },
      async handler(source, importer, options) {
        // eslint-disable-next-line unicorn/no-this-outside-of-class -- the plugin API hands the context as `this`
        const resolved = await this.resolve(source.slice(0, -MODULE_QUERY.length), importer, {
          ...options,
          skipSelf: true,
        });
        if (resolved === null) {
          return null;
        }
        const sha256 = wasm.shaFor(resolved.id);
        if (sha256 === undefined) {
          throw new Error(
            `@stayingupwind/adapter: ${resolved.id} is imported as WebAssembly but no output's trace named it; the Function would carry no such module`,
          );
        }
        const global = arkorWasmGlobal(sha256);
        wasm.publish(sha256, global);
        onResolved?.(resolved.id, global);
        return `${WASM_ID_PREFIX}${global}`;
      },
    },
    load: {
      filter: { id: /^arkor-wasm:/u },
      handler: (id) => {
        return {
          code: `export default globalThis.${id.slice(WASM_ID_PREFIX.length)};\n`,
          moduleType: 'js',
        };
      },
    },
  };
}

/** `@opentelemetry/api` falls back to Next.js's own copy, as Next.js falls back to it. */
export function vendoredOtelPlugin(onFallback?: (specifier: string) => void): Plugin {
  return {
    name: 'arkor-vendored-otel',
    resolveId: {
      filter: { id: /^@opentelemetry\/api$/u },
      async handler(source, importer, options) {
        // The app's own copy, when it installed one: preferred, as Next.js prefers it. Asked
        // of every plugin but this one, so that asking does not come back here.
        // eslint-disable-next-line unicorn/no-this-outside-of-class -- the plugin API hands the context as `this`
        const own = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (own !== null) {
          return own;
        }
        // eslint-disable-next-line unicorn/no-this-outside-of-class -- the plugin API hands the context as `this`
        const vendored = await this.resolve(VENDORED_OTEL_API, importer, {
          ...options,
          skipSelf: true,
        });
        // Nothing to fall back to either: let Rolldown report the import it could not resolve
        // rather than replace one unresolved specifier with another.
        if (vendored === null) {
          return null;
        }
        onFallback?.(OTEL_API);
        return vendored;
      },
    },
  };
}

/** How Next.js names a module holding a React context its renderers share with the application. */
const SHARED_RUNTIME = '.shared-runtime';
/** Where Next.js's require hook sends each of them: the Pages Router runtime's own copy. */
const VENDORED_CONTEXTS = 'next/dist/server/route-modules/pages/vendored/contexts/';
/** A module of Next.js's own that holds one, where a request for it resolves as it is. */
const NEXT_SHARED_RUNTIME =
  /[/\\]next[/\\]dist[/\\](?:esm[/\\])?shared[/\\]lib[/\\][^/\\]+\.shared-runtime\.js$/u;

/**
 * A module holding one of the contexts Next.js's renderers share with the application —
 * `*.shared-runtime`, the image config's among them — is the copy the Pages Router's runtime holds,
 * whichever module asks for it, as on Next.js's own server.
 *
 * That server installs a require hook ahead of any handler (`server/require-hook.ts`, which an
 * adapter's Node.js entries load through `next/setup-node-env`): each such `require` is sent to the
 * runtime's copy (`server/route-modules/pages/vendored/contexts/<name>`), so that a package left to
 * Node — one of `serverExternalPackages` — that renders `next/image` reads the context the renderer
 * provides, and not a second copy of it that nothing provides. The chunks Turbopack writes never ask
 * for one; they were resolved as Turbopack built them. What asks is a module of `node_modules` the
 * bundle reached as Node would have, which is what the hook is for. Without this, such an image was
 * sized as though the application had no `images` config (`next-image-new/image-from-node-modules`).
 *
 * A name the runtime has no copy of fails the build, as the hook's `require` would fail the render:
 * resolved the usual way instead, it would be the second copy of the context this is here to keep
 * out, and nothing would say so.
 *
 * Only a request that resolves to one of Next.js's own (`shared/lib/*.shared-runtime.js`) is sent:
 * the hook reads the name alone, and would send a package's own `./x.shared-runtime` to the runtime
 * as well, but a module of that name that is not Next.js's holds no context the runtime has.
 */
export function sharedRuntimePlugin(): Plugin {
  return {
    name: 'arkor-shared-runtime',
    resolveId: {
      filter: { id: /\.shared-runtime$/u },
      async handler(source, importer, options) {
        // eslint-disable-next-line unicorn/no-this-outside-of-class -- the plugin API hands the context as `this`
        const own = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (own === null || !NEXT_SHARED_RUNTIME.test(own.id)) {
          return own;
        }
        // As the hook asks for it: by name, from the module that asked.
        const runtimeCopy = `${VENDORED_CONTEXTS}${path.posix.basename(source, SHARED_RUNTIME)}`;
        // eslint-disable-next-line unicorn/no-this-outside-of-class -- the plugin API hands the context as `this`
        const resolved = await this.resolve(runtimeCopy, importer, { ...options, skipSelf: true });
        if (resolved === null) {
          throw new Error(
            `@stayingupwind/adapter: ${importer ?? 'a module'} requires ${source}, which Next.js's require hook sends to ${runtimeCopy}, and there is no such module; this Next.js version is not supported`,
          );
        }
        return resolved;
      },
    },
  };
}
