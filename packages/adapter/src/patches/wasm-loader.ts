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
 * chunk first needed it, so it is found by `marker` instead. No one string of the loader's will do
 * for that. An application chunk may well carry any of them — a route that answers with a `.wasm`,
 * a module that exports something called `compileModule` — and none is rare enough on its own to
 * fail a customer's build over, or to rewrite a customer's module for. So what is asked about is
 * the module, as `loaderAt` says.
 */

const NAME = 'wasm-loader';
/** Every server chunk: the loader is a shared module, so it lands in one of them, never in an entry. */
const TARGET = /\/server\/chunks\/.*\.js$/u;

/** The `Content-Type` the loader gives the response it builds around the file it read. */
const READS_A_FILE = /"content-type":\s*"application\/wasm"/gu;
/** What only a module reading a `.wasm` off disk as a stream has, on top of the `Content-Type`. */
const FILE_READ_MARKS = ['createReadStream', '.toWeb('];
/**
 * `(e.w,r)`: the file's path resolved against Turbopack's runtime root, which the loader reads off
 * the module's own context (`__turbopack_runtime_root__`) — the context it requires its modules
 * through as well (`e.r(…)`). An application module that streams a `.wasm` of its own has the rest
 * of a file read, and no reason to know where Turbopack's runtime is.
 */
const RUNTIME_ROOT_RESOLVE = /\((?<context>[\w$]+)\.w,\s*[\w$]+\)/u;
/** What a module of a chunk ends with: its registration. One between two places parts modules. */
const REGISTRATION = '.s([';
/** How far from its file read the loader module's registration and functions may be. */
const LOADER_SPAN = 2048;

/**
 * `.s(["compileModule",0,r,"instantiate",0,a])`: how the loader module registers its exports, or
 * the one of them a build imports where it imports only one. From 16.4 every production build
 * mangles the names — `.s(["A",0,s,"P",0,t])` — and the module that imports the loader asks for
 * `A` rather than `compileModule`, so the names are kept and what changes is the function each one
 * registers.
 */
const LOADER_EXPORTS = /^\.s\(\[(?:"[\w$]+",0,[\w$]+,?){1,2}\]\)/u;
const LOADER_ENTRY = /"(?<name>[\w$]+)",0,(?<local>[\w$]+)/gu;

type LoaderRole = 'compileModule' | 'instantiate';

const REPLACEMENTS: Readonly<Record<LoaderRole, string>> = {
  compileModule: '__arkorWasmCompile',
  instantiate: '__arkorWasmInstantiate',
};

/** What each of the loader's functions takes: the path, and for `instantiate` the imports too. */
const ROLE_BY_ARITY: Readonly<Partial<Record<number, LoaderRole>>> = {
  1: 'compileModule',
  2: 'instantiate',
};

const STREAMING_CALL: Readonly<Record<LoaderRole, string>> = {
  compileModule: 'WebAssembly.compileStreaming(',
  instantiate: 'WebAssembly.instantiateStreaming(',
};

interface LoaderRegistration {
  readonly at: number;
  readonly text: string;
  readonly exports: readonly { readonly name: string; readonly role: LoaderRole }[];
}

/** An export name the loader's own source gave, which says which function it is. */
function isRole(name: string): name is LoaderRole {
  return Object.hasOwn(REPLACEMENTS, name);
}

/**
 * The loader role of the function `local` declares before `before`, if it declares one in the same
 * module: a local of one letter is everybody's, and the nearest `function s(` back from a
 * registration is another module's wherever a registration stands between the two. `instantiate`
 * takes the imports as well as the path and calls `WebAssembly.instantiateStreaming`;
 * `compileModule` takes the path alone and calls `WebAssembly.compileStreaming`.
 */
function roleOf(source: string, local: string, before: number): LoaderRole | undefined {
  const declaration = `function ${local}(`;
  const at = source.lastIndexOf(declaration, before);
  if (at === -1 || before - at > LOADER_SPAN || source.slice(at, before).includes(REGISTRATION)) {
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

/**
 * The loader's registration, where the file read at `read` is the loader's.
 *
 * Read off the module the read is in and nothing else in the chunk. The registration is the first
 * after the read, which is the one that ends its module; the rest of a file read is in that module
 * too, its path resolved against Turbopack's runtime root (`RUNTIME_ROOT_RESOLVE`); and each export
 * the registration names is one of the loader's functions — by its name where the build kept the
 * name, and by what the function is where the build mangled it (`roleOf`).
 * Another module's export of the same name, or of a function of the same letter, belongs to a
 * module this never looks at, so it is never what gets rewritten.
 */
function loaderAt(source: string, read: number): LoaderRegistration | undefined {
  const at = source.indexOf(REGISTRATION, read);
  if (at === -1 || at - read > LOADER_SPAN) {
    return undefined;
  }
  const own = source.slice(Math.max(0, source.lastIndexOf(REGISTRATION, read)), at);
  if (FILE_READ_MARKS.some((mark) => !own.includes(mark))) {
    return undefined;
  }
  const context = RUNTIME_ROOT_RESOLVE.exec(own)?.groups?.['context'];
  if (context === undefined || !own.includes(`${context}.r(`)) {
    return undefined;
  }
  const found = LOADER_EXPORTS.exec(source.slice(at, at + LOADER_SPAN));
  if (found === null) {
    return undefined;
  }
  const exports: { name: string; role: LoaderRole }[] = [];
  const entries = [...found[0].matchAll(LOADER_ENTRY)];
  for (const entry of entries) {
    const name = entry.groups?.['name'];
    const local = entry.groups?.['local'];
    if (name === undefined || local === undefined) {
      return undefined;
    }
    const role = isRole(name) ? name : roleOf(source, local, at);
    if (role === undefined) {
      return undefined;
    }
    exports.push({ name, role });
  }
  // One export where a build imports one, which is a registration Turbopack writes as well as the
  // one with both; never the same function twice.
  if (new Set(exports.map((one) => one.role)).size !== exports.length) {
    return undefined;
  }
  return { at, text: found[0], exports };
}

/** Each copy of the loader a chunk carries, in the order they stand in it. */
function loaderRegistrations(source: string): LoaderRegistration[] {
  const found = new Map<number, LoaderRegistration>();
  for (const read of source.matchAll(READS_A_FILE)) {
    const registration = loaderAt(source, read.index);
    if (registration !== undefined) {
      found.set(registration.at, registration);
    }
  }
  return [...found.values()];
}

/**
 * `.s(["A",0,__arkorWasmCompile,"P",0,__arkorWasmInstantiate])`: the names kept, the functions
 * ours.
 */
function loaderExports(registration: LoaderRegistration): string {
  const entries = registration.exports.map((one) => `"${one.name}",0,${REPLACEMENTS[one.role]}`);
  return `.s([${entries.join(',')}])`;
}

/** `compileModule (A), instantiate (P)`: what each export is, and its name where it was mangled. */
function exportsNote(registration: LoaderRegistration): string {
  return registration.exports
    .map((one) => (one.name === one.role ? one.role : `${one.role} (${one.name})`))
    .join(', ');
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
  marker: (source) => loaderRegistrations(source).length > 0,
  // The chunk Turbopack put the loader in, which only a build has.
  reaches: ['build-output'],
  apply(source, file, ctx) {
    const registrations = loaderRegistrations(source);
    if (registrations.length === 0) {
      throw new Rewrite(NAME, file, source).fail(
        "expected the loader's exports 1 time(s), found 0",
      );
    }
    // Spliced where each was found rather than replaced by its text: a registration is a few
    // characters, and another module of the chunk may well spell the same. From the last, so each
    // splice leaves the ones before it where they were found.
    let contents = source;
    for (const registration of registrations.toReversed()) {
      const end = registration.at + registration.text.length;
      contents = `${contents.slice(0, registration.at)}${loaderExports(registration)}${contents.slice(end)}`;
    }
    // An empty table is not a failure: a Function may bundle the loader from a shared chunk while
    // none of its own entrypoints reaches WebAssembly, and then nothing ever asks it for one.
    const result = new Rewrite(NAME, file, contents, registrations.length).append(
      wasmTable(ctx.wasm),
    );
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [
        `wasm table: ${ctx.wasm.length} entries; exports: ${registrations.map((registration) => exportsNote(registration)).join('; ')}`,
      ],
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
 * runtime assigning a *function* to `contextPrototype.w`, the other by a module that reads a
 * `.wasm` off disk and registers the functions that compile and instantiate it.
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
