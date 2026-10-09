import type { Plugin } from 'esbuild';

import { jsLiteral } from './codegen.ts';
import { WasmCollector, wasmModuleName } from './wasm.ts';

export const OBJECT_WASM_NAMESPACE = 'upwind-object-wasm';

/** Native compiled modules are carried beside class code, without compiling at request time. */
export function objectWasm(beforeRead?: (file: string) => void): {
  readonly collector: WasmCollector;
  readonly inputs: Map<string, { readonly bytes: number; readonly module: string }>;
  readonly plugin: Plugin;
} {
  const collector = new WasmCollector();
  const inputs = new Map<string, { readonly bytes: number; readonly module: string }>();
  const plugin: Plugin = {
    name: OBJECT_WASM_NAMESPACE,
    setup(builder) {
      // eslint-disable-next-line require-unicode-regexp -- esbuild filters are Go regular expressions.
      builder.onResolve({ filter: /\.wasm(?:\?module)?$/, namespace: 'file' }, async (args) => {
        if (args.pluginData === OBJECT_WASM_NAMESPACE) return undefined;
        const resolved = await builder.resolve(args.path.replace(/\?module$/u, ''), {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: OBJECT_WASM_NAMESPACE,
        });
        if (resolved.errors.length > 0)
          return { errors: resolved.errors, warnings: resolved.warnings };
        beforeRead?.(resolved.path);
        const sha = await collector.offer(resolved.path);
        const module = wasmModuleName(sha);
        collector.publish(sha, module);
        const offered = collector.modules.find((entry) => entry.sha256 === sha);
        if (offered === undefined)
          throw new Error(`no compiled WebAssembly module for ${resolved.path}`);
        inputs.set(resolved.path, { bytes: offered.bytes.byteLength, module });
        return { path: `./${module}`, namespace: OBJECT_WASM_NAMESPACE };
      });
      // eslint-disable-next-line require-unicode-regexp -- esbuild filters are Go regular expressions.
      builder.onResolve({ filter: /.*/, namespace: OBJECT_WASM_NAMESPACE }, (args) => {
        return { path: args.path, external: true };
      });
      // eslint-disable-next-line require-unicode-regexp -- esbuild filters are Go regular expressions.
      builder.onLoad({ filter: /.*/, namespace: OBJECT_WASM_NAMESPACE }, (args) => {
        return { contents: `export { default } from ${jsLiteral(args.path)};`, loader: 'js' };
      });
    },
  };
  return { collector, inputs, plugin };
}
