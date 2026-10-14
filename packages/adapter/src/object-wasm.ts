import path from 'node:path';

import type { Plugin } from 'rolldown';

import { jsLiteral } from './codegen.ts';
import { WasmCollector, wasmModuleName } from './wasm.ts';

/** The id an imported `.wasm` is bundled under: no file is read for it. */
const OBJECT_WASM_PREFIX = '\0upwind-object-wasm:';

/**
 * Native compiled modules are carried beside class code, without compiling at request time.
 *
 * Whatever an import names — the file itself, the file with `?module`, a package export or a
 * `tsconfig.json` alias that leads to it — it is resolved as any other, and claimed when what it
 * resolves to is a `.wasm` file: the import becomes one of a module of the bundle's own that
 * re-exports the compiled module the Function carries under its digest. The same bytes reached by
 * any of those ways are one module, and a `require()` of one is handed that module's namespace, as
 * of any ES module.
 */
export function objectWasm(beforeRead?: (file: string) => void): {
  readonly collector: WasmCollector;
  readonly inputs: Map<string, { readonly bytes: number; readonly module: string }>;
  readonly plugin: Plugin;
} {
  const collector = new WasmCollector();
  const inputs = new Map<string, { readonly bytes: number; readonly module: string }>();
  const plugin: Plugin = {
    name: 'upwind-object-wasm',
    async resolveId(source, importer, options) {
      // The compiled module itself, which the Function carries beside the class module.
      if (importer?.startsWith(OBJECT_WASM_PREFIX) === true) return { id: source, external: true };
      // eslint-disable-next-line unicorn/no-this-outside-of-class -- the plugin API hands the context as `this`
      const resolved = await this.resolve(source.replace(/\?module$/u, ''), importer, {
        ...options,
        skipSelf: true,
      });
      if (
        resolved?.external !== false ||
        !path.isAbsolute(resolved.id) ||
        !resolved.id.endsWith('.wasm')
      )
        return null;
      beforeRead?.(resolved.id);
      const sha = await collector.offer(resolved.id);
      const module = wasmModuleName(sha);
      collector.publish(sha, module);
      const offered = collector.modules.find((entry) => entry.sha256 === sha);
      if (offered === undefined)
        throw new Error(`no compiled WebAssembly module for ${resolved.id}`);
      inputs.set(resolved.id, { bytes: offered.bytes.byteLength, module });
      return `${OBJECT_WASM_PREFIX}./${module}`;
    },
    load: {
      filter: { id: /^\0upwind-object-wasm:/u },
      handler: (id) => {
        return {
          code: `export { default } from ${jsLiteral(id.slice(OBJECT_WASM_PREFIX.length))};`,
          moduleType: 'js',
        };
      },
    },
  };
  return { collector, inputs, plugin };
}
