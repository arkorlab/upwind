import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Hex } from '@upwind/core/artifact';
import { compareCodeUnits } from '@upwind/core/util';

/**
 * The WebAssembly a build produced, and how it reaches the code that asks for it.
 *
 * A Worker carries each module as a module of its own (`wasm/<sha256>.wasm`, uploaded as
 * `CompiledWasm`), which Cloudflare compiles when the Worker is uploaded. So what a route awaits
 * at request time is already a `WebAssembly.Module`: nothing is read, nothing is compiled, and a
 * route that never touches WebAssembly never pays for it. The alternative — shipping the bytes
 * and calling `WebAssembly.compile()` — would pay the compile again in every isolate, on the
 * first request that reaches one.
 *
 * Getting from the module to the code is the one awkward part. `app.cjs` and `edge.cjs` are
 * CommonJS, and a CommonJS module cannot statically import a compiled-WebAssembly module; and
 * Turbopack's own edge runtime already reads the module off a global (`() => wasm_<hash>`, see
 * `edge/loadWasm.ts` in `turbopack-wasm`). So a generated ES module — `wasm.mjs`, imported by the
 * runtime — imports each module once and publishes it under every name that reads it:
 *
 * - `wasm_<hash>`, Turbopack's own, for an entrypoint built for the edge runtime. The name comes
 *   from `wasmAssets` and the chunks read it as a bare global; nothing else is needed.
 * - `__arkorWasm_<sha256>`, ours, for the Node.js runtime — where Turbopack's loader reads the
 *   file off disk, and the `wasm-loader` patch turns that read into this global — and for a
 *   `?module` import the app bundler resolved itself (`@vercel/og`'s, for one).
 *
 * The same bytes reached twice are one module with two names: the file is content-addressed, so
 * two outputs that bundle the same WebAssembly ship it once.
 */

const WASM_MODULE_DIR = 'wasm';
export const WASM_ENTRY_MODULE = 'wasm.mjs';
/** Long enough that a collision would be news; short enough to read in a generated file. */
const GLOBAL_DIGEST_LENGTH = 32;

export interface WasmModule {
  /** sha256 of the bytes, hex; names the module inside the Worker. */
  readonly sha256: string;
  readonly bytes: Uint8Array;
  /** Every global the Worker publishes the compiled module under, in the order they were asked. */
  readonly globals: readonly string[];
}

/** The name `wasm.mjs` publishes a module under for the Node.js runtime and for `?module`. */
export function arkorWasmGlobal(sha256: string): string {
  return `__arkorWasm_${sha256.slice(0, GLOBAL_DIGEST_LENGTH)}`;
}

export function wasmModuleName(sha256: string): string {
  return `${WASM_MODULE_DIR}/${sha256}.wasm`;
}

/**
 * Where the Turbopack loader for the Node.js runtime looks a module up. Its argument is the
 * path of the `.wasm` relative to the runtime root, which is the `distDir` — the same form the
 * chunk table in `patches/turbopack-runtime.ts` is keyed by.
 */
export interface WasmChunk {
  /** `server/chunks/fixtures_next-minimal_src_add_0athij3.wasm`. */
  readonly chunkPath: string;
  readonly global: string;
}

/**
 * Collects the WebAssembly one Worker carries.
 *
 * A file is `offer`ed and only ships once something `publish`es a name for it, because a trace
 * reaches more WebAssembly than a Worker runs: `@vercel/og` puts `resvg.wasm` and `yoga.wasm`
 * (1.6 MB between them) in the trace of every page that imports anything of Next.js's metadata,
 * whether or not the page renders an image. What ships is what some piece of code was found to
 * read, never what a trace merely mentioned.
 */
export class WasmCollector {
  readonly #bySha = new Map<string, { bytes: Uint8Array; globals: string[] }>();
  readonly #byFile = new Map<string, string>();

  /** Read `filePath` and remember its bytes; the digest names it everywhere from here on. */
  async offer(filePath: string): Promise<string> {
    const resolved = path.resolve(filePath);
    const known = this.#byFile.get(resolved);
    if (known !== undefined) {
      return known;
    }
    const bytes = new Uint8Array(await readFile(resolved));
    const sha256 = await sha256Hex(bytes);
    this.#byFile.set(resolved, sha256);
    if (!this.#bySha.has(sha256)) {
      this.#bySha.set(sha256, { bytes, globals: [] });
    }
    return sha256;
  }

  /** Name a module the Worker publishes: this is what makes it ship. */
  publish(sha256: string, global: string): void {
    const entry = this.#bySha.get(sha256);
    if (entry === undefined) {
      throw new Error(`@upwind/adapter: no WebAssembly module was offered for ${sha256}`);
    }
    if (!entry.globals.includes(global)) {
      entry.globals.push(global);
    }
  }

  /** The digest of a file already offered; `undefined` when no trace ever named it. */
  shaFor(filePath: string): string | undefined {
    return this.#byFile.get(path.resolve(filePath));
  }

  /** The modules that ship: every one something reads, in a stable order. */
  get modules(): WasmModule[] {
    return [...this.#bySha]
      .filter(([, entry]) => entry.globals.length > 0)
      .map(([sha256, entry]) => ({ sha256, bytes: entry.bytes, globals: [...entry.globals] }))
      .toSorted((left, right) => compareCodeUnits(left.sha256, right.sha256));
  }

  /**
   * Whether the build reached any WebAssembly at all. The runtime bundle is built alongside the
   * app bundle, before a `?module` import has been resolved, so this — and not `modules` — is
   * what decides whether the Worker has a `wasm.mjs` to import.
   */
  get hasCandidates(): boolean {
    return this.#bySha.size > 0;
  }
}

/**
 * `wasm.mjs`: one import per module, and one assignment per name that reads it.
 *
 * `??=` rather than `=` so that a module evaluated twice — which workerd does not do, but a test
 * harness might — does not replace a module a route already closed over.
 */
export function wasmEntrySource(modules: readonly WasmModule[]): string {
  const lines = modules.flatMap((module, index) => {
    const local = `wasm${index}`;
    return [
      `import ${local} from './${wasmModuleName(module.sha256)}';`,
      ...module.globals.map((global) => `globalThis.${global} ??= ${local};`),
    ];
  });
  return [
    '// Generated by @upwind/adapter: the WebAssembly this deployment carries.',
    '//',
    '// Cloudflare compiled each of these when the Worker was uploaded, so every name below is',
    "// already a `WebAssembly.Module`. `wasm_*` is what Turbopack's edge runtime reads;",
    "// `__arkorWasm_*` is what the Node.js runtime's patched loader and a `?module` import read.",
    ...lines,
    '',
  ].join('\n');
}

/**
 * The table the `wasm-loader` patch leaves behind, for the `.wasm` a build emitted under
 * `distDir`. One entry per path, however many traces named the file — a route's and the
 * instrumentation hook's may be the same `.wasm` — because the table is a `switch` on that path,
 * and the count of its entries is what the build reports.
 */
export function wasmChunks(
  distDir: string,
  files: readonly { filePath: string; sha256: string }[],
): WasmChunk[] {
  const byPath = new Map<string, WasmChunk>();
  for (const file of files) {
    const chunkPath = path.relative(distDir, file.filePath).split(path.sep).join('/');
    if (!byPath.has(chunkPath)) {
      byPath.set(chunkPath, { chunkPath, global: arkorWasmGlobal(file.sha256) });
    }
  }
  return [...byPath.values()];
}
