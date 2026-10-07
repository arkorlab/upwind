import { jsLiteral } from '../codegen.ts';
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

/**
 * `e.s(["A",0,s,"P",0,t])`: the same registration once Turbopack has mangled the export names,
 * which every production build does from 16.4. The names say nothing any more, and the module
 * that imports the loader asks for `A` rather than `compileModule`, so the names are kept and what
 * changes is the function each one registers.
 *
 * Which of the loader's two functions a local is gets read off the function itself: `instantiate`
 * takes the imports as well as the path and calls `WebAssembly.instantiateStreaming`, and
 * `compileModule` takes the path alone and calls `WebAssembly.compileStreaming`. The registration
 * looked at is the first after the file read, within the few hundred bytes the module spans, and a
 * local that is not declared there as such a function means this is not the loader.
 */
const MANGLED_EXPORTS = /\.s\(\[(?:"[\w$]+",0,[\w$]+,?){1,2}\]\)/u;
const MANGLED_ENTRY = /"(?<name>[\w$]+)",0,(?<local>[\w$]+)/gu;
/** How far from its file read the loader module's registration and functions may be. */
const LOADER_SPAN = 2048;
/** What only a module reading a `.wasm` off disk as a stream has, on top of the `Content-Type`. */
const FILE_READ_MARKS = ['createReadStream', '.toWeb('];

type LoaderRole = 'compileModule' | 'instantiate';

/** What each of the loader's functions takes: the path, and for `instantiate` the imports too. */
const ROLE_BY_ARITY: Readonly<Partial<Record<number, LoaderRole>>> = {
  1: 'compileModule',
  2: 'instantiate',
};

const STREAMING_CALL: Readonly<Record<LoaderRole, string>> = {
  compileModule: 'WebAssembly.compileStreaming(',
  instantiate: 'WebAssembly.instantiateStreaming(',
};

interface MangledRegistration {
  readonly at: number;
  readonly text: string;
  readonly exports: readonly { readonly name: string; readonly role: LoaderRole }[];
}

/** The loader role of the function `local` declares before `before`, if it declares one. */
function roleOf(source: string, local: string, before: number): LoaderRole | undefined {
  const declaration = `function ${local}(`;
  const at = source.lastIndexOf(declaration, before);
  if (at === -1 || before - at > LOADER_SPAN) {
    return undefined;
  }
  const open = at + declaration.length;
  const close = source.indexOf(')', open);
  if (close === -1 || close > before) {
    return undefined;
  }
  const parameters = source
    .slice(open, close)
    .split(',')
    .filter((parameter) => parameter.trim() !== '').length;
  const role = ROLE_BY_ARITY[parameters];
  return role !== undefined && source.slice(close, before).includes(STREAMING_CALL[role])
    ? role
    : undefined;
}

function mangledRegistration(source: string): MangledRegistration | undefined {
  const read = source.search(READS_A_FILE);
  if (read === -1) {
    return undefined;
  }
  const window = source.slice(Math.max(0, read - LOADER_SPAN), read + LOADER_SPAN);
  if (FILE_READ_MARKS.some((mark) => !window.includes(mark))) {
    return undefined;
  }
  const found = MANGLED_EXPORTS.exec(source.slice(read, read + LOADER_SPAN));
  if (found === null) {
    return undefined;
  }
  const at = read + found.index;
  const entries = [...found[0].matchAll(MANGLED_ENTRY)];
  const exports: { name: string; role: LoaderRole }[] = [];
  for (const entry of entries) {
    const name = entry.groups?.['name'];
    const local = entry.groups?.['local'];
    const role = local === undefined ? undefined : roleOf(source, local, at);
    if (name === undefined || role === undefined) {
      return undefined;
    }
    exports.push({ name, role });
  }
  // Two exports are the two functions, one of each.
  if (new Set(exports.map((one) => one.role)).size !== exports.length) {
    return undefined;
  }
  return { at, text: found[0], exports };
}

/** `.s(["A",0,__arkorWasmCompile,"P",0,__arkorWasmInstantiate])`: the names kept, the functions ours. */
function mangledExportRegistration(registration: MangledRegistration): string {
  const entries = registration.exports.map((one) => `"${one.name}",0,${REPLACEMENTS[one.role]}`);
  return `.s([${entries.join(',')}])`;
}

function wasmTable(chunks: readonly { chunkPath: string; global: string }[]): string {
  const cases = chunks.map(
    (chunk) => `    case ${jsLiteral(chunk.chunkPath)}: found = globalThis.${chunk.global}; break;`,
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
  marker: (source) => {
    if (!READS_A_FILE.test(source)) {
      return false;
    }
    return registeredExports(source).length > 0 || mangledRegistration(source) !== undefined;
  },
  // The chunk Turbopack put the loader in, which only a build has.
  reaches: ['build-output'],
  apply(source, file, ctx) {
    const exports = registeredExports(source);
    // An empty table is not a failure: a Function may bundle the loader from a shared chunk while
    // none of its own entrypoints reaches WebAssembly, and then nothing ever asks it for one.
    if (exports.length > 0) {
      const result = new Rewrite(NAME, file, source)
        .replace(EXPORTS, exportRegistration(exports), 1, "the loader's exports")
        .append(wasmTable(ctx.wasm));
      return {
        contents: result.contents,
        edits: result.edits,
        notes: [`wasm table: ${ctx.wasm.length} entries; exports: ${exports.join(', ')}`],
      };
    }
    const registration = mangledRegistration(source);
    if (registration === undefined) {
      throw new Rewrite(NAME, file, source).fail(
        "expected the loader's exports 1 time(s), found 0",
      );
    }
    // Spliced at the one place it was found rather than replaced by its text: a mangled
    // registration is a few characters, and another module of the chunk may well spell the same.
    const end = registration.at + registration.text.length;
    const spliced = `${source.slice(0, registration.at)}${mangledExportRegistration(registration)}${source.slice(end)}`;
    const result = new Rewrite(NAME, file, spliced, 1).append(wasmTable(ctx.wasm));
    const roles = registration.exports.map((one) => `${one.role} (${one.name})`);
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [`wasm table: ${ctx.wasm.length} entries; exports: ${roles.join(', ')}`],
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
