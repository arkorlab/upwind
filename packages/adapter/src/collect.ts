import type { Stats } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { isImmutableCacheControl } from '@stayingupwind/core/assets';
import {
  DEPLOYMENT_ID_PREFIX,
  type Entrypoint,
  type Prerender,
  type Route,
  type SourcePage,
  type StaticFile,
} from '@stayingupwind/core/bundle';
import { type ImagesConfig, imagesConfigFromNextManifest } from '@stayingupwind/core/images';
import { createId, isId } from '@stayingupwind/core/util';
import type { AdapterOutput, NextAdapter } from 'next';

import { type BlobStore, contentTypeFor } from './blobs.ts';
import type { EdgeEntry } from './edge.ts';
import type { EntryModule } from './function.ts';

/**
 * What the adapter reads from `onBuildComplete`, and what it makes of it. Each function here
 * takes a piece of the build context and gives back a piece of the bundle: the contract with
 * Next.js on one side (`README.md`, "What the adapter reads"), the contract with the host on the
 * other (`@stayingupwind/core/bundle`). Nothing here writes the bundle itself; that is `index.ts`.
 */

type NextBuildContext = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];

/**
 * `T` with `K` no longer required. Distributed over a union, because a prerender's type is one —
 * Next.js intersects it with a classification that is either present or entirely absent — and the
 * plain `Omit` collapses a union to the keys its members share.
 */
type Loosened<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K> & { [P in Extract<keyof T, K>]?: T[P] }
  : never;

/**
 * What `onBuildComplete` hands over, as this adapter reads it across the range it supports.
 *
 * Next.js's own type is the newest version's, because that is what the catalog pins and what this
 * repository typechecks against. The range starts at 16.2, which has not got two of the things
 * 16.3 added, and they are declared here as what they are across the range: optional. A build
 * against 16.2 carries neither, so the code that reads them has to say what it does without them.
 *
 * The prerender classification (`routeType`, `response`, `compute`, `htmlSize`) needs no such
 * widening — Next.js already types it as present or wholly absent, and everything here already
 * asks. What it costs a 16.2 deployment is that `edgeServablePrerenders` finds nothing, so every
 * prerender is answered by the Function rather than from the edge (`@stayingupwind/core/bundle`,
 * `generationIn`). Correct, and the slow way round; `index.ts` says so at the end of a build.
 */
export type BuildContext = Omit<NextBuildContext, 'outputs' | 'routing'> & {
  readonly routing: Loosened<NextBuildContext['routing'], 'middlewareMatchers'>;
  readonly outputs: Omit<NextBuildContext['outputs'], 'prerenders'> & {
    readonly prerenders: Loosened<NextBuildContext['outputs']['prerenders'][number], 'route'>[];
  };
};
type RouteOutput =
  | AdapterOutput['APP_PAGE']
  | AdapterOutput['APP_ROUTE']
  | AdapterOutput['PAGES']
  | AdapterOutput['PAGES_API'];

const RSC_SUFFIX = '.rsc';

/**
 * A build that keeps no server: `next build` writes `out/` and calls the adapter with nothing but
 * static files — no entrypoint, no prerender, no middleware (Next.js, "Output Types"). What the
 * platform serves is then the files themselves, and the Function answers only what is not one.
 */
export function isStaticExport(config: BuildContext['config']): boolean {
  return config.output === 'export';
}

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export function deploymentId(): string {
  const configured = process.env['NEXT_DEPLOYMENT_ID'];
  if (configured !== undefined && configured !== '') {
    if (!isId(DEPLOYMENT_ID_PREFIX, configured)) {
      throw new Error(
        `@stayingupwind/adapter: NEXT_DEPLOYMENT_ID must be a deployment id (dpl_…), got ${configured}`,
      );
    }
    return configured;
  }
  const generated = createId(DEPLOYMENT_ID_PREFIX);
  console.warn(
    `@stayingupwind/adapter: NEXT_DEPLOYMENT_ID is not set; using ${generated}. Assets will not carry a deployment id.`,
  );
  return generated;
}

/** The bundle's name for each of Next.js's route output types. */
const ENTRYPOINT_KINDS: Readonly<Record<string, Entrypoint['kind']>> = {
  APP_PAGE: 'app-page',
  APP_ROUTE: 'app-route',
  PAGES: 'pages',
  PAGES_API: 'pages-api',
};

function entrypointKind(output: RouteOutput): Entrypoint['kind'] {
  const kind = ENTRYPOINT_KINDS[output.type];
  if (kind === undefined) {
    throw new Error(`@stayingupwind/adapter: unknown output type ${output.type}`);
  }
  return kind;
}

/** The output id Next.js gives the Pages Router's home, whose module it names `/index`. */
const PAGES_HOME_ID = '/index';

/**
 * The id, and the pathname, an entrypoint is collected under: the pathname Next.js gave its output,
 * which is the URL it answers, with one exception. The Pages Router's home is named `/index`
 * (`normalizePagePath`), `/docs/index` under a `basePath`, and answers the application's root.
 * `@next/routing` resolves a request against the pathnames it is handed and knows nothing of that,
 * so a root the Function had to render — `getServerSideProps`, or a `getStaticProps` page not served
 * from the build — was answered with the not-found page. It is collected under the URL it answers.
 */
function entryIdOf(output: RouteOutput): string {
  const home =
    entrypointKind(output) === 'pages' &&
    output.id === PAGES_HOME_ID &&
    output.pathname.endsWith(PAGES_HOME_ID);
  return home ? output.pathname.slice(0, -PAGES_HOME_ID.length) || '/' : output.pathname;
}

const SERVER_CHUNKS_SEGMENT = `${path.sep}server${path.sep}chunks${path.sep}`;

/** The server chunks an output's trace reaches; these are what its Turbopack runtime may load. */
export function tracedChunks(assets: Record<string, string>): string[] {
  return Object.values(assets).filter(
    (file) => file.endsWith('.js') && file.includes(SERVER_CHUNKS_SEGMENT),
  );
}

/**
 * The WebAssembly an output on the Node.js runtime reaches.
 *
 * Next.js names WebAssembly in `wasmAssets` only for the edge runtime; on the Node.js runtime it
 * arrives as a `.wasm` among the traced `assets`, with nothing to say that it is anything but a
 * file. Which is exactly why it has to be looked for: dropped, the route builds and then fails on
 * its first request.
 */
export function tracedWasm(assets: Record<string, string>): string[] {
  return [...new Set(Object.values(assets).filter((file) => file.endsWith('.wasm')))];
}

/** Every file a `.nft.json` trace next to an entry names, resolved against the entry. */
async function nftFiles(entryFile: string): Promise<string[]> {
  const traceFile = `${entryFile}.nft.json`;
  if (!(await exists(traceFile))) {
    return [];
  }
  const trace = JSON.parse(await readFile(traceFile, 'utf8')) as { files?: string[] };
  const dir = path.dirname(entryFile);
  return (trace.files ?? []).map((file) => path.resolve(dir, file));
}

/** Chunks named by a `.nft.json` trace next to an entry that `onBuildComplete` does not describe. */
export async function nftChunks(entryFile: string): Promise<string[]> {
  return (await nftFiles(entryFile)).filter(
    (file) => file.endsWith('.js') && file.includes(SERVER_CHUNKS_SEGMENT),
  );
}

/**
 * Everything such an entry's trace names, keyed as an output's `assets` are: what it reads through
 * `node:fs` is among them, beside its code, for `tracedFiles` to tell apart.
 */
export async function nftAssets(entryFile: string): Promise<Record<string, string>> {
  return Object.fromEntries((await nftFiles(entryFile)).map((file) => [file, file]));
}

/**
 * The WebAssembly such an entry reaches. The instrumentation hook is the one entry the adapter
 * finds this way rather than being handed, and its chunks go into both Functions — so a `.wasm` it
 * imports has to be collected the same way, or the loader those chunks carry is rewritten with a
 * table that does not name it (and, when the build has no other WebAssembly, is not rewritten at
 * all and fails the build instead).
 */
export async function nftWasm(entryFile: string): Promise<string[]> {
  return [...new Set((await nftFiles(entryFile)).filter((file) => file.endsWith('.wasm')))];
}

/**
 * What among an edge output's `assets` is code, which the edge bundle evaluates, or WebAssembly,
 * which `wasmAssets` names; the rest are the files its chunks fetch as `blob:` URLs.
 */
const CHUNK_FILE = /\.(?:[cm]?js|map|wasm)$/u;

/**
 * What an output on the edge runtime needs to be invoked, as Next.js hands it over.
 *
 * `edgeRuntime` is the documented way to reach such an output ("Invoking Entrypoints"): its
 * chunks are evaluated, which registers the entry under `entryKey` in the global edge entry
 * registry, and the handler is read from there. The chunks are `assets` in the order Next.js
 * lists them, which is the order its own runtime evaluates them in.
 *
 * `wasmAssets` names the WebAssembly those chunks read, keyed by the global they read it from
 * (`wasm_<hash>`): Turbopack's edge loader takes a `() => wasm_<hash>` thunk and gives up with
 * "global was not injected" if the name is not there. The Function publishes it — see `wasm.ts`.
 *
 * The rest of `assets` are the files the chunks fetch by the name Next.js gave them
 * (`blob:server/edge/assets/font.ttf`), which Next.js's own edge runtime answers from the
 * function's assets (`fetchInlineAsset`) — see `edgeEntrySource`.
 */
export function edgeEntryOf(
  output: RouteOutput | AdapterOutput['MIDDLEWARE'],
  id: string,
): EdgeEntry {
  const { edgeRuntime } = output;
  if (edgeRuntime === undefined) {
    throw new Error(
      `@stayingupwind/adapter: ${id} is built for the edge runtime but has no edgeRuntime metadata`,
    );
  }
  const files = [...new Set(Object.values(output.assets).filter((file) => file.endsWith('.js')))];
  // The entry chunk carries the runtime that runs the others; Next.js lists it among the files,
  // and a build that stops doing so would register nothing at all.
  if (!files.includes(edgeRuntime.modulePath)) {
    files.push(edgeRuntime.modulePath);
  }
  return {
    id,
    entryKey: edgeRuntime.entryKey,
    handlerExport: edgeRuntime.handlerExport,
    files,
    wasm: Object.entries(output.wasmAssets ?? {}).map(([global, filePath]) => {
      return {
        global,
        filePath,
      };
    }),
    inlineAssets: Object.entries(output.assets)
      .filter(([, filePath]) => !CHUNK_FILE.test(filePath))
      .map(([name, filePath]) => ({ name, filePath })),
    env: output.config.env ?? {},
  };
}

/**
 * One entry per built module; the `.rsc` twin of an app page is the same file under another name.
 *
 * A route on the deprecated edge runtime is built differently — chunks that register a Web
 * handler, not a module the Function can require — so it is collected apart, into the Function's edge
 * bundle, and marked in the bundle so that nothing tries to resume it.
 */
export function collectEntrypoints(outputs: BuildContext['outputs']): {
  entrypoints: Entrypoint[];
  sourcePages: SourcePage[];
  modules: EntryModule[];
  chunks: string[];
  wasm: string[];
  edgeEntries: EdgeEntry[];
} {
  const entrypoints: Entrypoint[] = [];
  const sourcePages = new Map<string, SourcePage>();
  const modules = new Map<string, EntryModule>();
  const chunks = new Set<string>();
  const wasm = new Set<string>();
  const edgeEntries = new Map<string, EdgeEntry>();
  const all: RouteOutput[] = [
    ...outputs.appPages,
    ...outputs.appRoutes,
    ...outputs.pages,
    ...outputs.pagesApi,
  ];
  for (const output of all) {
    if (output.pathname.endsWith(RSC_SUFFIX)) {
      continue;
    }
    const id = entryIdOf(output);
    const edge = output.runtime === 'edge';
    entrypoints.push({
      id,
      kind: entrypointKind(output),
      pathname: id,
      ...(edge && { runtime: 'edge' as const }),
    });
    // An id is one module, so the first output to name it is the one that says where it came
    // from. An empty source page is not recorded at all: the bundle holds a path or nothing, and
    // a reader is told which (`sourcePageSchema`).
    if (!sourcePages.has(id) && output.sourcePage !== '') {
      sourcePages.set(id, { id, sourcePage: output.sourcePage });
    }
    if (edge) {
      edgeEntries.set(id, edgeEntryOf(output, id));
      continue;
    }
    modules.set(id, { id, filePath: output.filePath });
    for (const chunk of tracedChunks(output.assets)) {
      chunks.add(chunk);
    }
    for (const file of tracedWasm(output.assets)) {
      wasm.add(file);
    }
  }
  return {
    entrypoints,
    sourcePages: [...sourcePages.values()],
    modules: [...modules.values()],
    chunks: [...chunks],
    wasm: [...wasm],
    edgeEntries: [...edgeEntries.values()],
  };
}

type PrerenderOutput = BuildContext['outputs']['prerenders'][number];

/** The entry id each page is collected under (`collectEntrypoints`), by the page's output id. */
function entryIdsByOutputId(outputs: BuildContext['outputs']): Map<string, string> {
  const ids = new Map<string, string>();
  const pages: RouteOutput[] = [
    ...outputs.appPages,
    ...outputs.appRoutes,
    ...outputs.pages,
    ...outputs.pagesApi,
  ];
  for (const output of pages) {
    if (!output.pathname.endsWith(RSC_SUFFIX) && !ids.has(output.id)) {
      ids.set(output.id, entryIdOf(output));
    }
  }
  return ids;
}

/**
 * Which route a prerender belongs to, as an entry id.
 *
 * Next.js names every output's `pathname` under the `basePath` before the adapter runs — a page's,
 * which is the id its module is required by (see `collectEntrypoints`), as much as a prerender's —
 * but leaves a prerender's source `route` bare. The runtime finds a pathname's shell by the route
 * the router resolved, which carries the `basePath`, and renders or resumes it through the entry
 * that route names; so the route has to be an entry id.
 *
 * It is the entry id of the page the prerender came from (`parentOutputId`), where that page is
 * one. Naming the source route under the `basePath` gives the same id for every page but the
 * Pages Router's home, whose source route under a `basePath` of `/docs` is `/docs/` while its entry
 * is `/docs` (`entryIdOf`), so no entry answered to it. A prerender with no page of its own among
 * the entries keeps its source route under the `basePath`.
 *
 * `route` itself arrived in 16.3, and a 16.2 build that leaves a prerender with neither a route
 * nor a parent among the entries has said nothing about where it belongs. Guessing is the one
 * thing not to do: the runtime groups prerenders by route and answers a pathname with the shell of
 * the route it resolved, so a route taken from the pathname would file every member of
 * `/blog/[slug]` under its own name and serve one page's shell for another's. The build names the
 * prerender it could not place and stops. No prerender of any fixture built against 16.2 has
 * needed this — every one of them had a parent among the entries.
 */
function routeOf(
  output: PrerenderOutput,
  entryIds: ReadonlyMap<string, string>,
  basePath: string,
): string {
  const entry = entryIds.get(output.parentOutputId);
  if (entry !== undefined) {
    return entry;
  }
  if (output.route === undefined) {
    throw new Error(
      `@stayingupwind/adapter: the prerender ${output.id} (${output.pathname}) has no source route, and its parent output ${output.parentOutputId} is not among the entrypoints; Next.js 16.3 is the first to carry one, so this build cannot say which route it belongs to`,
    );
  }
  return withBasePath(basePath, output.route);
}

/** What the bundle records about a prerender, apart from its blobs. */
function prerenderFields(output: PrerenderOutput, route: string): Prerender {
  return {
    id: output.id,
    pathname: output.pathname,
    route,
    parentOutputId: output.parentOutputId,
    groupId: output.groupId,
    ...(output.routeType !== undefined && { routeType: output.routeType }),
    ...(output.response !== undefined && { response: output.response }),
    ...(output.compute !== undefined && { compute: output.compute }),
    ...(output.config.renderingMode !== undefined && {
      renderingMode: output.config.renderingMode,
    }),
    ...(output.htmlSize !== undefined && { htmlSize: output.htmlSize }),
    ...(output.fallback?.initialStatus !== undefined && {
      initialStatus: output.fallback.initialStatus,
    }),
    ...(output.fallback?.initialHeaders !== undefined && {
      initialHeaders: output.fallback.initialHeaders,
    }),
    ...(output.fallback?.initialRevalidate !== undefined && {
      initialRevalidate: output.fallback.initialRevalidate,
    }),
    ...(output.fallback?.initialExpiration !== undefined && {
      initialExpiration: output.fallback.initialExpiration,
    }),
    ...(output.pprChain !== undefined && { pprChain: output.pprChain }),
    ...(output.config.allowQuery !== undefined && { allowQuery: output.config.allowQuery }),
    ...(output.config.allowHeader !== undefined && { allowHeader: output.config.allowHeader }),
    ...(output.config.bypassFor !== undefined && { bypassFor: output.config.bypassFor }),
    ...(output.parentFallbackMode !== undefined && {
      parentFallbackMode: output.parentFallbackMode,
    }),
    ...(output.config.partialFallback !== undefined && {
      partialFallback: output.config.partialFallback,
    }),
  };
}

/**
 * What a request must carry to be in draft mode. Next.js generates one per build and records it
 * on every prerender it writes; the platform is the one that reads it, since it decides which
 * requests are answered from the build and which are rendered (Adapters, "Prerendered routes").
 */
export function bypassTokenOf(outputs: BuildContext['outputs']): string | undefined {
  for (const output of outputs.prerenders) {
    const { bypassToken } = output.config;
    if (bypassToken !== undefined && bypassToken !== '') {
      return bypassToken;
    }
  }
  return undefined;
}

export async function collectPrerenders(
  outputs: BuildContext['outputs'],
  blobs: BlobStore,
  basePath: string,
): Promise<{ prerenders: Prerender[]; shipped: { sha256: string; bytes: Uint8Array }[] }> {
  const prerenders: Prerender[] = [];
  const shipped = new Map<string, Uint8Array>();
  const entryIds = entryIdsByOutputId(outputs);
  for (const output of outputs.prerenders) {
    const prerender = prerenderFields(output, routeOf(output, entryIds, basePath));
    const filePath = output.fallback?.filePath;
    if (filePath !== undefined && (await exists(filePath))) {
      const bytes = new Uint8Array(await readFile(filePath));
      const ref = await blobs.put(bytes, contentTypeFor(filePath));
      shipped.set(ref.sha256, bytes);
      prerender.body = ref;
    }
    const postponed = output.fallback?.postponedState;
    if (postponed !== undefined && postponed !== '') {
      const bytes = new TextEncoder().encode(postponed);
      const ref = await blobs.put(bytes, 'text/plain; charset=utf-8');
      shipped.set(ref.sha256, bytes);
      prerender.postponed = ref;
    }
    prerenders.push(prerender);
  }
  return {
    prerenders,
    shipped: [...shipped].map(([sha256, bytes]) => ({ sha256, bytes })),
  };
}

/**
 * Every file under `dir`, symbolic links followed.
 *
 * An application may keep a file or a whole shared asset directory under `public/` through a link,
 * and `next start` serves what it points at. A `Dirent` for one is neither a directory nor a file,
 * so reading only those two silently shipped nothing for a URL the application does expose — a 404
 * in production for an asset that works locally.
 *
 * `stat` follows the link, and `realpath` is what keeps a link that points at an ancestor from
 * walking for ever: a directory already on the way here is not descended into again.
 */
async function walk(dir: string, seen: ReadonlySet<string> = new Set()): Promise<string[]> {
  const here = await realpath(dir);
  if (seen.has(here)) {
    return [];
  }
  const visited = new Set([...seen, here]);
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const stats = entry.isSymbolicLink() ? await statOf(full) : entry;
    if (stats === undefined) {
      // A link with nothing at the end of it: `next start` would answer that path with a 404 too.
      continue;
    }
    if (stats.isDirectory()) {
      out.push(...(await walk(full, visited)));
    } else if (stats.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** Every pathname Next.js names carries the app's `basePath`; so does everything named here. */
function withBasePath(basePath: string, pathname: string): string {
  return `${basePath}${pathname}`;
}

async function statOf(target: string): Promise<Stats | undefined> {
  try {
    return await stat(target);
  } catch {
    return undefined;
  }
}

const HTML_SUFFIX = '.html';
const INDEX_SUFFIX = '/index';

/**
 * Where a static export's file is asked for.
 *
 * `next build` hands an exported file's path from `out/` with `.html` taken off, so `out/index.html`
 * arrives as `/index` — a name no visitor types. What a visitor types is decided by which file the
 * build chose to write, and that is what `trailingSlash` settles:
 *
 * - The root document is `out/index.html` under either setting, and is asked for as the site's
 *   root. Without a `basePath` that is `/` either way; with one it is the spelling Next.js
 *   redirects the other to.
 * - With `trailingSlash`, every page is written as its directory's index (`out/about/index.html`)
 *   and asked for with the slash (`/about/`).
 * - Without it, a page is written beside its siblings (`out/about.html` → `/about`), and a
 *   `.../index.html` is then not a directory index at all but a route whose own last segment is
 *   `index` (`app/blog/index/page.tsx` → `out/blog/index.html` → `/blog/index`). Taking the
 *   segment off would serve the page at a URL the application does not have and leave the one it
 *   does have to the Function's not-found.
 *
 * Everything that is not HTML — `_next/static`, `public/`, the RSC payloads the client router
 * fetches — is served under the name it has, and is returned unchanged.
 */
export function exportedPathname(
  output: Pick<AdapterOutput['STATIC_FILE'], 'filePath' | 'pathname'>,
  config: { readonly basePath: string; readonly trailingSlash: boolean },
): string {
  const { basePath } = config;
  if (!output.filePath.endsWith(HTML_SUFFIX) || !output.pathname.endsWith(INDEX_SUFFIX)) {
    return output.pathname;
  }
  const parent = output.pathname.slice(basePath.length, -INDEX_SUFFIX.length);
  if (parent === '') {
    return basePath === '' || config.trailingSlash ? `${basePath}/` : basePath;
  }
  return config.trailingSlash ? `${basePath}${parent}/` : output.pathname;
}

const CACHE_CONTROL = 'cache-control';

/**
 * Whether the build says a file's name may be cached forever and shared across deployments.
 *
 * A static export turns `supportsImmutableAssets` off (Next.js forces it in `finalizeConfig`), so
 * no file arrives with an `immutableHash` — but the build still emits the rule its own server
 * answers `_next/static` under, naming the directories whose file names carry a content hash or
 * the build id. That rule is read here rather than guessed at: without it every hashed chunk of a
 * static export would go out `must-revalidate` and be revalidated on every visit.
 *
 * What the rule has to say is a whole policy — long-lived, public, nothing withholding it — and
 * not the word `immutable`, which on its own qualifies a freshness `no-store` may take away.
 *
 * It is the build's answer and not a better one: an app whose `generateBuildId` returns a constant
 * has a `_next/static/<buildId>/` that two builds can fill differently, and Next.js's own server
 * sends that path `immutable` all the same.
 *
 * The rules are a list the router applies in order, with the later of two naming one header
 * winning, and only an answer that holds for every request can become a flag on a file. So the
 * rules are walked in the order the router walks them: an unconditional rule is what every request
 * ends on, and so replaces whatever stood before it; a rule with a `has` or a `missing` holds for
 * some requests and not others, and can therefore only take immutability away from what stands at
 * that point — one that comes before an unconditional rule takes nothing, because that rule is
 * what every request ends on instead.
 */
export function immutableByBuild(onMatch: readonly Route[], pathname: string): boolean {
  let immutable = false;
  for (const rule of onMatch) {
    const cacheControl = cacheControlOf(rule);
    if (cacheControl === undefined || !matchesPath(rule.sourceRegex, pathname)) {
      continue;
    }
    // The whole policy, not the `immutable` token: `public, max-age=0, immutable` and
    // `private, no-store, immutable` are neither long-lived nor shareable, and the edge's own
    // asset admission already reads a `cache-control` this way.
    const saysImmutable = isImmutableCacheControl(cacheControl);
    if (rule.has !== undefined || rule.missing !== undefined) {
      immutable &&= saysImmutable;
      continue;
    }
    immutable = saysImmutable;
  }
  return immutable;
}

function cacheControlOf(rule: Route): string | undefined {
  return Object.entries(rule.headers ?? {}).find(
    ([name]) => name.toLowerCase() === CACHE_CONTROL,
  )?.[1];
}

function matchesPath(sourceRegex: string, pathname: string): boolean {
  // Compiled by Next.js for its own router, which runs it without the unicode flag.
  // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
  return new RegExp(sourceRegex).test(pathname);
}

/**
 * The other URL a static file answers, when the name Next.js gave it is not one.
 *
 * A Pages Router page with no data function is written as a static file named by
 * `normalizePagePath`, which spells the home page `/index` — the one output whose name is not
 * the path it is asked for. The file is offered under the application's root as well; the name
 * the build gave it stays, since a rewrite in `next.config` may still name it.
 */
function aliasPathname(pathname: string, basePath: string): string | undefined {
  return pathname === `${basePath}/index` ? basePath || '/' : undefined;
}

/**
 * The content type a static file is served with. A metadata file the build prerendered
 * (`/robots.txt`, `/favicon.ico`, `/manifest.webmanifest`) is written as `<route>.body`, a name
 * that says nothing about what it holds, so its type comes from the name it is served under.
 */
function staticFileContentType(
  output: Pick<AdapterOutput['STATIC_FILE'], 'filePath' | 'pathname'>,
): string {
  return contentTypeFor(output.filePath.endsWith('.body') ? output.pathname : output.filePath);
}

/**
 * `_next/static` from the build output, plus everything under `public/`. Next.js names its own
 * outputs under the `basePath`; a public file is requested under it too (`/docs/manual.pdf`),
 * and is named so here.
 *
 * A static export is the whole site instead: `next build` hands over everything it wrote to
 * `out/`, `public/` copied in and all, so the directory is not walked a second time, and each file
 * is named where a static host would serve it (`exportedPathname`).
 */
export async function collectStaticFiles(
  ctx: BuildContext,
  blobs: BlobStore,
): Promise<StaticFile[]> {
  const basePath = orDefault(ctx.config.basePath, '');
  const exported = isStaticExport(ctx.config);
  const naming = { basePath, trailingSlash: orDefault(ctx.config.trailingSlash, false) };
  const files: StaticFile[] = [];
  for (const output of ctx.outputs.staticFiles) {
    const blob = await blobs.putFile(output.filePath, staticFileContentType(output));
    // The name the file is served under, which is the name a rule is judged against: a document
    // moves from `/index` to `/` and from `/about/index` to `/about/`, and the edge matches the
    // header rules on the request's own pathname, not on the one the build handed over.
    const pathname = exported ? exportedPathname(output, naming) : output.pathname;
    const immutable = exported
      ? immutableByBuild(ctx.routing.onMatch, pathname)
      : output.immutableHash !== undefined;
    files.push({ pathname, blob, immutable });
    // A Pages Router page written as `/index` answers the application's root under both names. An
    // export needs no alias: every document of one is already named where a static host serves it,
    // and a rewrite — the reason the build's own name is kept — is not followed for one anyway.
    const alias = exported ? undefined : aliasPathname(output.pathname, basePath);
    if (alias !== undefined) {
      files.push({ pathname: alias, blob, immutable });
    }
  }
  const publicDir = path.join(ctx.projectDir, 'public');
  if (!exported && (await exists(publicDir))) {
    const publicFiles = await walk(publicDir);
    for (const file of publicFiles) {
      // As a URL names it: the edge and the runtime look a file up by the request's own pathname.
      const pathname = `/${path
        .relative(publicDir, file)
        .split(path.sep)
        .map((segment) => encodeURIComponent(segment))
        .join('/')}`;
      files.push({
        pathname: withBasePath(basePath, pathname),
        blob: await blobs.putFile(file, contentTypeFor(file)),
        immutable: false,
      });
    }
  }
  return files;
}

export function middlewareMatchers(middleware: AdapterOutput['MIDDLEWARE'] | undefined): Route[] {
  return (middleware?.config.matchers ?? []).map((matcher) => {
    return {
      source: matcher.source,
      sourceRegex: matcher.sourceRegex,
      ...(matcher.has !== undefined && { has: matcher.has }),
      ...(matcher.missing !== undefined && { missing: matcher.missing }),
    };
  });
}

/**
 * The routing tables, with the one phase 16.3 added filled in where a build did not carry it.
 *
 * `routing.middlewareMatchers` is what decides whether the middleware runs for a request, and the
 * runtime hands it to `@next/routing` as a phase of its own. A 16.2 build has no such field — it
 * describes the same thing one place along, on the middleware output — so that is what fills it.
 * The two are the same table: `middlewareMatchers` above builds the phase out of exactly it, and
 * from 16.3 on Next.js builds the phase out of it too. A build with no middleware has no matchers
 * either way.
 */
export function bundleRouting(
  routing: BuildContext['routing'],
  middleware: AdapterOutput['MIDDLEWARE'] | undefined,
): Omit<BuildContext['routing'], 'middlewareMatchers'> & { middlewareMatchers: Route[] } {
  return {
    ...routing,
    middlewareMatchers: routing.middlewareMatchers ?? middlewareMatchers(middleware),
  };
}

/**
 * What `next/image` needs enforced behind `/_next/image`, read from the manifest the build wrote
 * for exactly this purpose (its source patterns come compiled to regular expressions). Absent
 * when the application turned optimization off or brought its own loader.
 */
export async function imagesConfig(ctx: BuildContext): Promise<ImagesConfig | undefined> {
  const file = path.join(ctx.distDir, 'images-manifest.json');
  if (!(await exists(file))) {
    return undefined;
  }
  return imagesConfigFromNextManifest(
    JSON.parse(await readFile(file, 'utf8')),
    ctx.config.basePath,
  );
}

/**
 * A field `NextConfigComplete` types as present that `onBuildComplete` may not hand over.
 *
 * `defaultConfig` in `next/dist/server/config-shared` leaves `skipTrailingSlashRedirect`
 * undefined, so an app that never writes the option in its config has no value for it — while
 * the type says it does. Reading it straight off the context therefore type-checks and then
 * fails the bundle schema at the very end of a build. `fixtures/next-export` leaves the option
 * out for exactly that reason; every other app here sets it, which is why nothing saw this.
 *
 * The fallbacks are Next.js's own, so an option left out means here what it means there.
 */
export function orDefault<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

/**
 * The middleware output, when there is one.
 *
 * `proxy.ts` (Node.js) and the deprecated `middleware.ts` (edge) are built from the same Next.js
 * template and export the same Web handler; only where the code lives differs, which is what
 * `runtime` says and what decides which of a Function's two bundles carries it.
 */
export function middlewareOutput(
  outputs: BuildContext['outputs'],
): AdapterOutput['MIDDLEWARE'] | undefined {
  return outputs.middleware;
}
