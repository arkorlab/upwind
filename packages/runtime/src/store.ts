import { readFileSync } from 'node:fs';

import {
  type DeploymentBundle,
  type EntrypointKind,
  isPagesDataPathname,
  type Prerender,
  type StaticFile,
} from '@upwind/core/bundle';
import { ByteLru } from '@upwind/core/util';

/**
 * What the Worker knows about its deployment. Everything is read from the Worker's own bundle
 * through the virtual file system (`/bundle/...`), once per isolate, and never from the network:
 * a deployment is immutable, so the bytes shipped with the code are the truth for its lifetime.
 */

const BUNDLE_ROOT = '/bundle';
const RUNTIME_MANIFEST = 'runtime.json';
const LAST_SEGMENT_NAMES_NO_FILE = /\/[^./]+$/u;
const KIB = 1024;
const MIB = KIB * KIB;
const BLOB_MEMO_MIB = 8;
/**
 * How much of the bundle's blobs an isolate keeps copies of. They are the build's documents, the
 * states that resume them and the files the Worker carries — the kind of bytes the cache
 * runtime's record memo holds for a generation, asked for on the same path (a document the Worker
 * answers itself), so they get the same budget (`cache/runtime.ts`). The rest of a Worker's
 * 128 MB is left to Next.js and to every request in flight.
 */
const BLOB_MEMO_BYTES = BLOB_MEMO_MIB * MIB;

/**
 * The runtime manifest: the deployment bundle minus the parts only the platform needs. Its
 * `staticFiles` are the few shipped with the Worker (documents and `public/`), not `_next/static`.
 */
type RuntimeManifest = Omit<DeploymentBundle, 'workers' | 'projectDir' | 'generatedAt'>;

interface RouteShells {
  /** Prerenders whose URL has no dynamic segment left, by pathname (`/en` → shell). */
  readonly pages: ReadonlyMap<string, Prerender>;
  /** Shells that stand in for a class of URLs, tried in order of specificity. */
  readonly patterns: readonly { pattern: RegExp; prerender: Prerender }[];
}

export interface Store {
  readonly manifest: RuntimeManifest;
  readonly prerendersById: ReadonlyMap<string, Prerender>;
  readonly prerendersByPathname: ReadonlyMap<string, Prerender>;
  /** Document shells per source route (`/[locale]` → its pages and patterns). */
  readonly shellsByRoute: ReadonlyMap<string, RouteShells>;
  /** Static files shipped with the Worker, by pathname. */
  readonly staticFiles: ReadonlyMap<string, StaticFile>;
  /** Every pathname Next.js's router should treat as existing on the filesystem. */
  readonly pathnames: string[];
  /**
   * Those pathnames spelled with a trailing slash, each to the pathname it spells, when the
   * application keeps its pages there (`trailingSlash`). Next.js redirects such a page's path to
   * the spelling with a slash, and its filesystem check takes the slash off again before it looks
   * (`getItem`, `server/lib/router-utils/filesystem.ts`). `@next/routing` looks a pathname up as
   * it is, so each spelling is among `pathnames` too, and this finds the page it resolved to.
   */
  readonly slashSpellings: ReadonlyMap<string, string>;
  readBlob(sha256: string): Uint8Array<ArrayBuffer>;
}

/** A `[param]`, `[...rest]` or `[[...rest]]` segment: it starts with a bracket, and no other does. */
function isDynamicSegment(segment: string): boolean {
  return segment.startsWith('[');
}

function escapeRegex(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** One segment of a template as a pattern, with the slash before it, which an optional catch-all may drop. */
function segmentPattern(segment: string): string {
  if (segment.startsWith('[[...') && segment.endsWith(']]')) {
    return '(?:/.*)?';
  }
  if (segment.startsWith('[...') && segment.endsWith(']')) {
    return '/.+';
  }
  if (segment.startsWith('[') && segment.endsWith(']')) {
    return '/[^/]+';
  }
  return `/${escapeRegex(segment)}`;
}

/**
 * `/en/[orgSlug]` → `^/en/[^/]+$`; `/docs/[...slug]` → `^/docs/.+$`; `/docs/[[...slug]]` →
 * `^/docs(?:/.*)?$`, so that `/docs` itself, the empty catch-all, is a member.
 */
function patternFor(pathname: string): RegExp {
  const source =
    pathname === '/'
      ? '/'
      : pathname
          .split('/')
          .slice(1)
          .map((segment) => segmentPattern(segment))
          .join('');
  // Built from the route's own segments, every literal escaped above.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^${source}$`, 'u');
}

function isDocumentPrerender(prerender: Prerender): boolean {
  return prerender.routeType !== undefined && prerender.routeType !== 'route';
}

function buildShells(prerenders: readonly Prerender[]): Map<string, RouteShells> {
  const byRoute = new Map<
    string,
    { pages: Map<string, Prerender>; patterns: { pattern: RegExp; prerender: Prerender }[] }
  >();
  for (const prerender of prerenders) {
    if (!isDocumentPrerender(prerender)) {
      continue;
    }
    let entry = byRoute.get(prerender.route);
    if (entry === undefined) {
      entry = { pages: new Map(), patterns: [] };
      byRoute.set(prerender.route, entry);
    }
    if (prerender.pathname.split('/').some((segment) => isDynamicSegment(segment))) {
      entry.patterns.push({ pattern: patternFor(prerender.pathname), prerender });
    } else {
      entry.pages.set(prerender.pathname, prerender);
    }
  }
  const shells = new Map<string, RouteShells>();
  for (const [route, entry] of byRoute) {
    // More literal segments first: `/en/[orgSlug]` before `/[locale]/[orgSlug]`.
    entry.patterns.sort((a, b) => {
      return (
        countDynamic(a.prerender.pathname) - countDynamic(b.prerender.pathname) ||
        b.prerender.pathname.length - a.prerender.pathname.length
      );
    });
    shells.set(route, { pages: entry.pages, patterns: entry.patterns });
  }
  return shells;
}

function countDynamic(pathname: string): number {
  return pathname.split('/').filter((segment) => isDynamicSegment(segment)).length;
}

function readBundleFile(name: string): Uint8Array<ArrayBuffer> {
  // The bundle's own virtual file system: nothing a request names reaches this.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const buffer = readFileSync(`${BUNDLE_ROOT}/${name}`);
  // A copy on its own ArrayBuffer: `Response` bodies and the fetch API refuse shared buffers.
  return new Uint8Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
}

/**
 * Prerenders the router resolves by name, as Next.js's own filesystem check does.
 *
 * Two kinds, and no others. A `_next/data` output is the only thing a Pages Router data request
 * can land on: the matchers `next build` emits for data URLs point at the data pathname itself,
 * so a build that does not offer it there resolves nothing — the template among them, which
 * carries no body, is how an unbuilt member of the route is reached. And a member of a route
 * built with `fallback: false` — `dynamicParams = false` in the App Router — is all that route
 * will ever serve: the matcher `next build` emits for such a route carries the draft-mode
 * cookies as conditions, so nothing but a draft reaches the route at all, and a member that did
 * not resolve by its own name would resolve nowhere.
 *
 * Naming a pathname here makes it the route the request resolved to, which is not the route the
 * build filed its shell under; `renderedBy` puts that back, so a member of a closed route is
 * still served from its shell and resumed rather than rendered whole.
 *
 * Every other prerender is reached through its route's entrypoint, which is where the shell and
 * the resume that completes it come from; naming those here would cost every request a longer
 * scan of this list for nothing.
 */
function resolvedByName(prerender: Prerender): boolean {
  return isPagesDataPathname(prerender.pathname) || prerender.parentFallbackMode === false;
}

/**
 * Whether Next.js spells `pathname` with a trailing slash under `trailingSlash`: a path whose last
 * segment names no file, which its redirect gives the slash. A template is never asked for by
 * name with one: a dynamic route's matcher takes the slash itself.
 */
function takesTrailingSlash(pathname: string): boolean {
  return LAST_SEGMENT_NAMES_NO_FILE.test(pathname) && !pathname.includes('[');
}

/**
 * What the router resolves exactly: the pages, the Pages Router's data routes (which its dynamic
 * routes rewrite to), the shipped files, the spellings of those with a trailing slash when the
 * application keeps its pages there, and the optimizer's own path, which Next.js answers ahead of
 * its rewrites and dynamic routes as a file of its own.
 */
export function routerPathnames(
  manifest: Pick<RuntimeManifest, 'config' | 'entrypoints' | 'prerenders' | 'staticFiles'>,
): Pick<Store, 'pathnames' | 'slashSpellings'> {
  const named = [
    ...manifest.entrypoints.map((entry) => entry.pathname),
    ...manifest.prerenders.filter((prerender) => resolvedByName(prerender)).map((p) => p.pathname),
    ...manifest.staticFiles.map((file) => file.pathname),
  ];
  const slashSpellings = new Map(
    manifest.config.trailingSlash
      ? named
          .filter((pathname) => takesTrailingSlash(pathname))
          .map((pathname) => [`${pathname}/`, pathname] as const)
      : [],
  );
  return {
    pathnames: [
      ...named,
      ...slashSpellings.keys(),
      ...(manifest.config.images === undefined ? [] : [manifest.config.images.path]),
    ],
    slashSpellings,
  };
}

/** The store for this isolate; parsed on first use and kept for its lifetime. */
const shared: { store: Store | undefined } = { store: undefined };

export function getStore(): Store {
  if (shared.store !== undefined) {
    return shared.store;
  }
  const manifest = JSON.parse(
    new TextDecoder().decode(readBundleFile(RUNTIME_MANIFEST)),
  ) as RuntimeManifest;
  const prerendersById = new Map(manifest.prerenders.map((prerender) => [prerender.id, prerender]));
  const prerendersByPathname = new Map(
    manifest.prerenders.map((prerender) => [prerender.pathname, prerender]),
  );
  // Every read is a copy (`readBundleFile`), and a copy kept is the blob held twice: the least
  // recently read goes first, and one larger than the whole budget is copied afresh every time.
  const blobs = new ByteLru<string, Uint8Array<ArrayBuffer>>(BLOB_MEMO_BYTES);
  const staticFiles = new Map(manifest.staticFiles.map((file) => [file.pathname, file]));
  shared.store = {
    manifest,
    prerendersById,
    prerendersByPathname,
    shellsByRoute: buildShells(manifest.prerenders),
    staticFiles,
    ...routerPathnames(manifest),
    readBlob(sha256) {
      let bytes = blobs.get(sha256);
      if (bytes === undefined) {
        bytes = readBundleFile(`blobs/${sha256}`);
        blobs.set(sha256, bytes, bytes.byteLength);
      }
      return bytes;
    },
  };
  return shared.store;
}

/** The document shell for a concrete URL of `route`, if the build produced one. */
export function findShell(store: Store, route: string, pathname: string): Prerender | undefined {
  const shells = store.shellsByRoute.get(route);
  if (shells === undefined) {
    return undefined;
  }
  const page = shells.pages.get(pathname);
  if (page !== undefined) {
    return page;
  }
  return shells.patterns.find(({ pattern }) => pattern.test(pathname))?.prerender;
}

/** The kind of code a route runs: an App Router page or handler, a Pages Router page or API. */
export function entrypointKindOf(store: Store, route: string): EntrypointKind | undefined {
  return store.manifest.entrypoints.find((entry) => entry.pathname === route)?.kind;
}
