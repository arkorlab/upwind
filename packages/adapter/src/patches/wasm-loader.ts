import { type Patch, Rewrite } from './types.ts';

/**
 * Turbopack's WebAssembly loader for the Node.js runtime reads the module off disk:
 *
 * ```js
 * function readWebAssemblyAsResponse(filePath) {
 *   const { createReadStream } = require('fs');
 *   const { Readable } = require('stream');
 *   const stream = createReadStream(resolve(__turbopack_runtime_root__, filePath));
 *   return new Response(Readable.toWeb(stream), { headers: { 'content-type': 'application/wasm' } });
 * }
 * async function compileModule(chunkPath) { return WebAssembly.compileStreaming(readWebAssemblyAsResponse(chunkPath)) }
 * async function instantiate(chunkPath, imports) { … WebAssembly.instantiateStreaming(…) … }
 * ```
 *
 * A Function has no such file, and compiling at request time is what this platform is trying not to
 * do: Cloudflare already compiled the module when the Function was uploaded. So the module's two
 * exports become reads of the module the Function carries, keyed by the very path Turbopack asks
 * for — the `.wasm` relative to the runtime root, which is `distDir`, the same form the chunk
 * table in `turbopack-runtime.ts` is keyed by.
 *
 * Only the export registration is rewritten, because it is the only part of the module whose
 * shape does not depend on how many places use it: the helper above is a named declaration when
 * both exports call it and an inlined anonymous expression when only one does, so a rewrite of
 * the helper's own text refused every build that imported a `.wasm` one way rather than both.
 * What is left of the loader is unreferenced — nothing exports it — and the bundler drops it.
 *
 * Unlike the other patches this one cannot name its file: Turbopack puts the loader in whichever
 * chunk first needed it, so it is found by `marker` instead. The marker asks for both of the
 * module's marks at once — the registration, and the `Content-Type` the file read gives its
 * response — because an application chunk may well carry one of them (a route that answers with
 * a `.wasm`, a module that exports something called `compileModule`) and neither is rare enough
 * on its own to fail a customer's build over.
 */

const NAME = 'wasm-loader';
/** Every server chunk: the loader is a shared module, so it lands in one of them, never in an entry. */
const TARGET = /\/server\/chunks\/.*\.js$/u;

/** `e.s(["compileModule",0,r,"instantiate",0,a])`: how the loader module registers its exports. */
const EXPORTS = /\.s\(\[(?:"(?:compileModule|instantiate)",0,[\w$]+,?)+\]\)/gu;
const EXPORT_NAME = /"(?<name>compileModule|instantiate)"/gu;
/** The `Content-Type` the loader gives the response it builds around the file it read. */
const READS_A_FILE = /"content-type":\s*"application\/wasm"/u;

const REPLACEMENTS: Readonly<Record<string, string>> = {
  compileModule: '__arkorWasmCompile',
  instantiate: '__arkorWasmInstantiate',
};

/** The export names the loader module registers, in the order it registers them. */
function registeredExports(source: string): string[] {
  const registration = source.match(EXPORTS);
  if (registration === null) {
    return [];
  }
  return [...registration.join('').matchAll(EXPORT_NAME)].flatMap((match) =>
    match.groups?.['name'] === undefined ? [] : [match.groups['name']],
  );
}

/** `"compileModule",0,__arkorWasmCompile,"instantiate",0,__arkorWasmInstantiate`, as registered. */
function exportRegistration(exports: readonly string[]): string {
  const entries = exports.map((name) => `"${name}",0,${REPLACEMENTS[name]}`);
  return `.s([${entries.join(',')}])`;
}

function wasmTable(chunks: readonly { chunkPath: string; global: string }[]): string {
  const cases = chunks.map(
    (chunk) =>
      `    case ${JSON.stringify(chunk.chunkPath)}: found = globalThis.${chunk.global}; break;`,
  );
  return [
    '',
    'function __arkorWasmModule(chunkPath) {',
    '  let found;',
    '  switch (chunkPath) {',
    ...cases,
    '  }',
    '  if (found === undefined) {',
    "    throw new Error('@stayingupwind/adapter: no WebAssembly module for ' + chunkPath);",
    '  }',
    '  return found;',
    '}',
    '// eslint-disable-next-line @typescript-eslint/require-await -- the shape Turbopack compiled against',
    'async function __arkorWasmCompile(chunkPath) {',
    '  return __arkorWasmModule(chunkPath);',
    '}',
    '// `WebAssembly.instantiate` resolves with the instance alone when it is given a module, and',
    '// with `{ module, instance }` when it is given bytes — which is what the streaming call this',
    '// replaces was given. The loader wants the exports either way.',
    'async function __arkorWasmInstantiate(chunkPath, imports) {',
    '  const instance = await WebAssembly.instantiate(__arkorWasmModule(chunkPath), imports);',
    '  return instance.exports;',
    '}',
    '',
  ].join('\n');
}

export const wasmLoaderPatch: Patch = {
  name: NAME,
  target: TARGET,
  marker: (source) => READS_A_FILE.test(source) && registeredExports(source).length > 0,
  // The chunk Turbopack put the loader in, which only a build has.
  reaches: ['build-output'],
  apply(source, file, ctx) {
    const exports = registeredExports(source);
    // An empty table is not a failure: a Function may bundle the loader from a shared chunk while
    // none of its own entrypoints reaches WebAssembly, and then nothing ever asks it for one.
    const result = new Rewrite(NAME, file, source)
      .replace(EXPORTS, exportRegistration(exports), 1, "the loader's exports")
      .append(wasmTable(ctx.wasm));
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [`wasm table: ${ctx.wasm.length} entries; exports: ${exports.join(', ')}`],
    };
  },
};

/**
 * The same loader, where 16.2 keeps it: inside the Turbopack runtime itself.
 *
 * Next.js 16.3 moved these two out into a module of their own — the one the patch above finds by
 * marker — and left the runtime exposing only the root they resolve against
 * (`contextPrototype.w = RUNTIME_ROOT`). In 16.2 the runtime carries them:
 *
 * ```js
 * function loadWebAssembly(chunkPath, _edgeModule, imports) {
 *   const resolved = path.resolve(RUNTIME_ROOT, chunkPath);
 *   return instantiateWebAssemblyFromPath(resolved, imports);
 * }
 * function loadWebAssemblyModule(chunkPath, _edgeModule) {
 *   const resolved = path.resolve(RUNTIME_ROOT, chunkPath);
 *   return compileWebAssemblyFromPath(resolved);
 * }
 * ```
 *
 * Different code in a different file, and the same two things: one compiles, one instantiates, and
 * both are handed the `.wasm` path relative to the runtime root — which is `distDir`, the form the
 * table is keyed by. So the bodies become calls into the same table, and the helpers they called
 * are left unreferenced for the bundler to drop.
 *
 * The two shapes cannot both be present, and each is found by what only it has: this one by the
 * runtime assigning a *function* to `contextPrototype.w`, the other by a module registering
 * `compileModule` and `instantiate` as its exports.
 */
const RUNTIME_NAME = 'runtime-wasm-loader';
const RUNTIME_TARGET = /\[turbopack\]_runtime\.js$/u;
/** 16.2 assigns the loader here; 16.3 assigns `RUNTIME_ROOT`, which is not a thing to rewrite. */
const RUNTIME_LOADER = 'contextPrototype.w = loadWebAssembly;';
const RUNTIME_INSTANTIATE =
  /const resolved = path\.resolve\(RUNTIME_ROOT, chunkPath\);\s*return instantiateWebAssemblyFromPath\(resolved, imports\);/gu;
const RUNTIME_COMPILE =
  /const resolved = path\.resolve\(RUNTIME_ROOT, chunkPath\);\s*return compileWebAssemblyFromPath\(resolved\);/gu;
const RUNTIME_LEFTOVERS = [/WebAssemblyFromPath\(resolved/u];

export const runtimeWasmLoaderPatch: Patch = {
  name: RUNTIME_NAME,
  target: RUNTIME_TARGET,
  marker: (source) => source.includes(RUNTIME_LOADER),
  // The Turbopack runtime `next build` writes; a published package holds nothing for this.
  reaches: ['build-output'],
  apply(source, file, ctx) {
    const result = new Rewrite(RUNTIME_NAME, file, source)
      .replace(
        RUNTIME_INSTANTIATE,
        'return __arkorWasmInstantiate(chunkPath, imports);',
        1,
        "the runtime's WebAssembly instantiation",
      )
      .replace(
        RUNTIME_COMPILE,
        'return __arkorWasmCompile(chunkPath);',
        1,
        "the runtime's WebAssembly compilation",
      )
      .forbid(RUNTIME_LEFTOVERS, 'a WebAssembly read from a resolved path')
      .append(wasmTable(ctx.wasm));
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [`wasm table: ${String(ctx.wasm.length)} entries`],
    };
  },
};
