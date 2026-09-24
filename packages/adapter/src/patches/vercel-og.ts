import { type Patch, Rewrite } from './types.ts';

/**
 * `next/og` — the `ImageResponse` behind an `opengraph-image` or `twitter-image` route.
 *
 * Next.js ships two builds of `@vercel/og` and leaves the choice to the runtime's conditions. A
 * Node.js build picks `index.node.js`, which Turbopack keeps external: the chunk it emits is one
 * line, `externalImport("next/dist/compiled/@vercel/og/index.node.js")`, a module named at run
 * time that no bundler can follow and that a Worker therefore does not have. So every request to
 * such a route fails — and would still fail if the module were bundled, because that build reads
 * `resvg.wasm` and its fallback font off disk with `fs.readFileSync`, and then compiles the
 * WebAssembly on the spot, in every isolate, on the first request to reach one.
 *
 * `index.edge.js` is the same library built for a runtime with neither a file system nor a
 * compile budget, and it is written in exactly the form a Worker wants:
 * `import resvg_wasm from "./resvg.wasm?module"`. Cloudflare compiles those two modules at
 * upload, `wasmModulePlugin` resolves the imports to the globals the Worker publishes, and
 * nothing is read at run time. So the external import becomes an `import()` of that build — a
 * dynamic one, deliberately: the bundler can follow it, and the library it names is then
 * evaluated by the first request that renders an image rather than at the Worker's start.
 *
 * What is left is its fallback font, which it `fetch`es from its own `import.meta.url` — a
 * `file:` URL under `node_modules`, which `fetch` in a Worker will not open. The font travels
 * with the Worker instead and is read back through the same virtual file system the runtime
 * reads its manifests and blobs from.
 */

const NODE_BUILD = 'next/dist/compiled/@vercel/og/index.node.js';
const EDGE_BUILD = 'next/dist/compiled/@vercel/og/index.edge.js';

/** The font file, next to the library; the build reads it from there to ship it. */
export const OG_FONT_FILE = 'Geist-Regular.ttf';
/** The module name the fallback font travels under; read back at `/bundle/<name>`. */
export const OG_FONT_MODULE = `assets/vercel-og/${OG_FONT_FILE}`;
const OG_FONT_PATH = `/bundle/${OG_FONT_MODULE}`;

const IMPORT_PATCH = 'vercel-og';
/**
 * Turbopack's chunks for the external: the one with `externalImport(<the node build>)` and
 * nothing else, and — once more than one route reaches for `next/og` — a loader under the same
 * name that only fetches that chunk and resolves its module. The loader carries no import to
 * rewrite; the marker tells the two apart, and the loader is left as it is.
 */
const IMPORT_TARGET =
  /\/server\/chunks\/\[externals\]_next_dist_compiled_@vercel_og_index_node_[^/]*\.js$/u;
/**
 * `<context>.y("next/dist/compiled/@vercel/og/index.node.js")` — the whole call, receiver
 * included, so that what replaces it is a complete expression and not something glued to the
 * identifier in front of it.
 */
const EXTERNAL_IMPORT =
  // eslint-disable-next-line sonarjs/super-linear-regex -- run once per build over a file `next build` wrote, never over anything a request carries
  /[\w$]+\.y\("next\/dist\/compiled\/@vercel\/og\/index\.node\.js"\)/gu;
/** Nothing may be left touching the import: `e` + `import(…)` is `eimport(…)`, and bundles. */
const GLUED_IMPORT = /[\w$]import\(/u;

export const vercelOgPatch: Patch = {
  name: IMPORT_PATCH,
  target: IMPORT_TARGET,
  marker: (source) => source.includes(NODE_BUILD),
  nextVersions: ['16.3.5', '16.3.6'],
  apply(source, file) {
    const result = new Rewrite(IMPORT_PATCH, file, source)
      .replace(EXTERNAL_IMPORT, `import(${JSON.stringify(EDGE_BUILD)})`, 1, 'the external import')
      .forbid([NODE_BUILD], "the library's Node.js build")
      .forbid([GLUED_IMPORT], 'a call glued to the import');
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [`${NODE_BUILD} -> ${EDGE_BUILD}`],
    };
  },
};

const IMAGE_RESPONSE_PATCH = 'vercel-og-image-response';
/**
 * `next/dist/server/og/image-response.js` — what an application's own `import … from '@vercel/og'`
 * is, since `next build` aliases the package to it (`create-compiler-aliases`, `'@vercel/og$'`).
 * Turbopack keeps it external (`e.x("next/dist/server/og/image-response", …)`), so the Worker
 * bundles it from `node_modules`, where two things in it reach for what a Worker does not have.
 */
const IMAGE_RESPONSE_TARGET = /\/next\/dist\/server\/og\/image-response\.js$/u;
/**
 * The library, by the build `NEXT_RUNTIME` picks — the Node.js one, since the app Worker is
 * bundled with `NEXT_RUNTIME` pinned to `"nodejs"`. That is the build the patch above keeps out,
 * for the reasons it gives; it also brings `sharp`, a native module whose loader the bundler
 * cannot follow.
 */
const RUNTIME_PICK = `import(process.env.NEXT_RUNTIME === 'edge' ? '${EDGE_BUILD}' : '${NODE_BUILD}')`;
/**
 * The Cache Components path, behind a flag `next build` writes into what it bundles
 * (`define-env`) and a module left out of the bundle reads from the process's environment, where
 * nothing of Next.js's sets it: on `next start` the branch never runs, and the modules it would
 * require — `react-server-dom-webpack/static` and `/client` — are not installed for it to find.
 * Bundled here, the branch is followed all the same and names two modules a Worker has not got.
 */
const CACHED_BODY =
  /\nif \(process\.env\.NEXT_RUNTIME !== 'edge' && process\.env\.__NEXT_CACHE_COMPONENTS\) \{\n {4}getCachedImageResponseBody = require\('\.\/cache-image-response'\)\.getCachedImageResponseBody;\n\}/gu;

export const vercelOgImageResponsePatch: Patch = {
  name: IMAGE_RESPONSE_PATCH,
  target: IMAGE_RESPONSE_TARGET,
  nextVersions: ['16.3.5', '16.3.6'],
  apply(source, file) {
    const result = new Rewrite(IMAGE_RESPONSE_PATCH, file, source)
      .replace(RUNTIME_PICK, `import(${JSON.stringify(EDGE_BUILD)})`, 1, "the library's import")
      .replace(CACHED_BODY, '', 1, 'the Cache Components path')
      .forbid([NODE_BUILD], "the library's Node.js build")
      .forbid(['cache-image-response'], 'the Cache Components path');
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [`${NODE_BUILD} -> ${EDGE_BUILD}`, 'Cache Components path left out'],
    };
  },
};

const FONT_PATCH = 'vercel-og-font';
const FONT_TARGET = /\/next\/dist\/compiled\/@vercel\/og\/index\.edge\.js$/u;
/** `fetch(\n  new URL("./Geist-Regular.ttf", import.meta.url)\n).then((res) => res.arrayBuffer())`. */
const FALLBACK_FONT =
  /fetch\(\n {2}new URL\("\.\/Geist-Regular\.ttf", import\.meta\.url\)\n\)\.then\(\(res\) => res\.arrayBuffer\(\)\)/gu;
const FONT_IMPORT = 'import { readFileSync as __arkorReadFile } from "node:fs";\n';
/**
 * A `Buffer` shares a pooled `ArrayBuffer` with whatever else was read near it, so the bytes are
 * copied out at their own offset; the library hands the result to satori as a font file.
 */
const FONT_READER = [
  '',
  'function __arkorOgFallbackFont() {',
  `  const bytes = __arkorReadFile(${JSON.stringify(OG_FONT_PATH)});`,
  '  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);',
  '}',
  '',
].join('\n');

export const vercelOgFontPatch: Patch = {
  name: FONT_PATCH,
  target: FONT_TARGET,
  nextVersions: ['16.3.5', '16.3.6'],
  apply(source, file) {
    const result = new Rewrite(FONT_PATCH, file, FONT_IMPORT + source)
      .replace(
        FALLBACK_FONT,
        'Promise.resolve(__arkorOgFallbackFont())',
        1,
        'the fallback font fetch',
      )
      .forbid([/Geist-Regular\.ttf", import\.meta\.url/u], 'a font read from a file URL')
      .append(FONT_READER);
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [`fallback font: ${OG_FONT_PATH}`],
    };
  },
};
