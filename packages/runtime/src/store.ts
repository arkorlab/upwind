import { readFileSync, statSync } from 'node:fs';

import {
  type DeploymentBundle,
  documentPrerenders,
  type EntrypointKind,
  type ManifestHead,
  type PackedPrerenders,
  placeholderSegments,
  type Prerender,
  queryDependent,
  routerPathnames as namedExactly,
  type Route,
  standsForClass,
  type StaticFile,
  unpackPrerenders,
} from '@stayingupwind/core/bundle';
import { completedPathname, keyedParameters } from '@stayingupwind/core/manifest';
import { ByteLru } from '@stayingupwind/core/util';

/**
 * What the Function knows about its deployment. Everything is read from the Function's own bundle
 * through the virtual file system (`/bundle/...`), once per isolate, and never from the network:
 * a deployment is immutable, so the bytes shipped with the code are the truth for its lifetime.
 */

const BUNDLE_ROOT = '/bundle';
const RUNTIME_MANIFEST = 'runtime.json';
/** What `next build` puts in front of a dynamic route's pattern in an application with `i18n`. */
const LOCALE_PATTERN = '[/]?(?<nextLocale>[^/]{1,})';
/** And in front of the page the route's destination names. */
const LOCALE_DESTINATION = '/$nextLocale';
const API_PREFIX = '/api/';
const NAMED_GROUP = /\(\?<([A-Za-z_$][\w$]*)>/gu;
/** A destination's reference to a group by its place, as 16.4 writes the one to a page's suffix. */
const POSITIONAL_REFERENCE = /\$(\d+)/gu;
/** What a named group is renamed to, before its index (`withDistinctGroups`). */
const RENAMED_GROUP = 'arkorG';
const RENAMED_GROUP_DIGITS = 3;
const KIB = 1024;
const MIB = KIB * KIB;
const BLOB_MEMO_MIB = 8;
/**
 * How much of the bundle's blobs an isolate keeps copies of. They are the build's documents, the
 * states that resume them and the files the Function carries — the kind of bytes the cache
 * runtime's record memo holds for a generation, asked for on the same path (a document the Function
 * answers itself), so they get the same budget (`cache/runtime.ts`). The rest of a Function's
 * 128 MB is left to Next.js and to every request in flight.
 */
const BLOB_MEMO_BYTES = BLOB_MEMO_MIB * MIB;

/**
 * The runtime manifest: the deployment bundle minus the parts only the platform needs. Its
 * `staticFiles` are the few shipped with the Function (documents and `public/`), not `_next/static`.
 */
type RuntimeManifest = Omit<DeploymentBundle, 'functions' | 'projectDir' | 'generatedAt'>;

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
  /** Static files shipped with the Function, by pathname. */
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
  /** The dynamic routes as the router is handed them (`routerDynamicRoutes`). */
  readonly dynamicRoutes: readonly Route[];
  /**
   * What the build rendered of the Pages Router (`getStaticProps`), which Next.js answers only reads
   * of (`readsOnly`, in `methods.ts`): each such page's route and its pathname, since a request for a
   * member the build prerendered resolves to the member's pathname rather than to its route.
   */
  readonly renderedPages: ReadonlySet<string>;
  readBlob(sha256: string): Uint8Array<ArrayBuffer>;
  /**
   * The same read for a blob the bundle may only *name*: `undefined` where the bytes are not here.
   *
   * A host that serves an output itself can have the build record it and leave its bytes out of
   * the Function (`AdapterOptions.unshippedOutputs`). The record is what the host places from, so
   * it stays — and then a reference is no longer a promise that the file exists. `readBlob` throws
   * for one that does not, which is right everywhere the bundle is the only source; this is for
   * the paths that have somewhere else to go. A blob found absent is remembered so: the bundle does
   * not change while the isolate lives, and a read that fails costs a thrown error.
   */
  tryReadBlob(sha256: string): Uint8Array<ArrayBuffer> | undefined;
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
 * `^/docs(?:/.*)?$`, so that `/docs` itself, the empty catch-all, is a member. Only the route's own
 * placeholders are patterns (`placeholderSegments`): a value that holds a bracket is matched as it is.
 */
function patternFor(pathname: string, route: string): RegExp {
  const placeholders = placeholderSegments(pathname, route);
  const source =
    pathname === '/'
      ? '/'
      : pathname
          .split('/')
          .map((segment, index) =>
            placeholders[index] === true ? segmentPattern(segment) : `/${escapeRegex(segment)}`,
          )
          .slice(1)
          .join('');
  // Built from the route's own segments, every literal escaped above.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^${source}$`, 'u');
}

function buildShells(
  prerenders: readonly Prerender[],
  isDocument: (prerender: Prerender) => boolean,
): Map<string, RouteShells> {
  const byRoute = new Map<
    string,
    { pages: Map<string, Prerender>; patterns: { pattern: RegExp; prerender: Prerender }[] }
  >();
  for (const prerender of prerenders) {
    if (!isDocument(prerender)) {
      continue;
    }
    let entry = byRoute.get(prerender.route);
    if (entry === undefined) {
      entry = { pages: new Map(), patterns: [] };
      byRoute.set(prerender.route, entry);
    }
    if (standsForClass(prerender)) {
      entry.patterns.push({ pattern: patternFor(prerender.pathname, prerender.route), prerender });
    } else {
      entry.pages.set(prerender.pathname, prerender);
    }
  }
  const shells = new Map<string, RouteShells>();
  for (const [route, entry] of byRoute) {
    // More literal segments first: `/en/[orgSlug]` before `/[locale]/[orgSlug]`.
    entry.patterns.sort((a, b) => {
      return (
        countPlaceholders(a.prerender) - countPlaceholders(b.prerender) ||
        b.prerender.pathname.length - a.prerender.pathname.length
      );
    });
    shells.set(route, { pages: entry.pages, patterns: entry.patterns });
  }
  return shells;
}

function countPlaceholders(prerender: Prerender): number {
  return placeholderSegments(prerender.pathname, prerender.route).filter(Boolean).length;
}

/**
 * The same read for a file the bundle may not carry; `undefined` rather than a throw.
 *
 * Only an absent file is answered that way — anything else about the read is the caller's to see,
 * since a bundle this runtime cannot read is not a condition to carry on through.
 */
function readBundleFileIfThere(name: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return readBundleFile(name);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Metadata of an immutable bundle blob; HEAD must not read or copy its body bytes. */
export function hasBundleBlob(sha256: string): boolean {
  try {
    // Only a selected, build-owned BlobRef reaches this path, never a request's pathname.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return statSync(`${BUNDLE_ROOT}/blobs/${sha256}`).isFile();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
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
 * What the router resolves exactly, read once for the runtime and for the checks a bundle's gates
 * are held to, which follow the router to where it lands a request (`routerPathnames`, in
 * `@stayingupwind/core/bundle`): the pages, the shipped files, the prerenders it resolves by name,
 * their spellings behind a trailing slash, and the optimizer's own path. That function itself,
 * typed by the manifest a store is made from and the store it goes into: no call of its own.
 */
export const routerPathnames: (
  manifest: Pick<RuntimeManifest, 'config' | 'entrypoints' | 'prerenders' | 'staticFiles'>,
) => Pick<Store, 'pathnames' | 'slashSpellings'> = namedExactly;

/**
 * The dynamic routes as the router is handed them: the build's, with an API route of an
 * application with `i18n` matched without a locale in front of it.
 *
 * `next build` writes every dynamic route of such an application to match behind a locale
 * (`build/adapter/build-complete.ts`), since Next.js's router puts the default one in front of a
 * path that names none. It takes the locale out again before it matches an API route, and matches
 * none for an API path asked for behind one (`checkLocaleApi`, `resolve-routes.ts`).
 * `@next/routing` puts no locale in front of an `/api/` path, so the build's pattern matched
 * `/en/api/blog/first` and never `/api/blog/first`: every request to a dynamic API route of such an
 * application answered 404 (`i18n-api-support`). 16.3.6 and 16.4.0-canary.41 route alike.
 */
export function routerDynamicRoutes(manifest: {
  readonly config: RuntimeManifest['config'];
  readonly routing: Pick<RuntimeManifest['routing'], 'dynamicRoutes'>;
}): readonly Route[] {
  return unlocalizedApiRoutes(manifest).map((route) => withDistinctGroups(route));
}

/**
 * A route whose destination `@next/routing` fills in from each named group as it should. It
 * replaces a destination's `$name`s one name at a time (`replaceDestination`, 16.3.6; fixed in
 * 16.4.0-canary.41, which replaces the longest first in one pass), so a name that begins another —
 * `nxtPid` in `nxtPid2`, for `[id]/[id2]` — replaced the start of the other's as well: `/a/b`
 * rendered with an `id2` of `a2` (`use-params`), as would `[team]/[teamId]`. Such a route's groups
 * are renamed alike, in its pattern and its destination, to names of one length, none of which can
 * begin another; any other route is handed over as the build wrote it.
 */
function withDistinctGroups(route: Route): Route {
  const names = [...route.sourceRegex.matchAll(NAMED_GROUP)].map((match) => match[1] ?? '');
  const clashes = names.some((name) =>
    names.some((other) => other !== name && other.startsWith(name)),
  );
  if (!clashes || route.destination === undefined) {
    return route;
  }
  let { sourceRegex, destination } = route;
  // The longest first, so no name is renamed inside a longer one that begins with it.
  const renames = names
    .map((name, index) => {
      return {
        name,
        renamed: `${RENAMED_GROUP}${String(index).padStart(RENAMED_GROUP_DIGITS, '0')}`,
      };
    })
    .toSorted((a, b) => b.name.length - a.name.length);
  for (const { name, renamed } of renames) {
    // Handed back by a function, whose result is taken as it is: a replacement string reads `$`.
    sourceRegex = sourceRegex.replaceAll(`(?<${name}>`, () => `(?<${renamed}>`);
    destination = destination.replaceAll(`$${name}`, () => `$${renamed}`);
  }
  return { ...route, sourceRegex, destination };
}

/** The build's dynamic routes, with an i18n application's API routes matched without a locale. */
function unlocalizedApiRoutes(manifest: {
  readonly config: RuntimeManifest['config'];
  readonly routing: Pick<RuntimeManifest['routing'], 'dynamicRoutes'>;
}): readonly Route[] {
  const { config, routing } = manifest;
  if (config.i18n === null || config.i18n === undefined) {
    return routing.dynamicRoutes;
  }
  const localizedPattern = `^${config.basePath}${LOCALE_PATTERN}`;
  const localizedDestination = `${config.basePath}${LOCALE_DESTINATION}`;
  return routing.dynamicRoutes.map((route) => {
    const { destination } = route;
    if (
      route.source?.startsWith(API_PREFIX) !== true ||
      !route.sourceRegex.startsWith(localizedPattern) ||
      destination?.startsWith(`${localizedDestination}/`) !== true
    ) {
      return route;
    }
    return {
      ...route,
      sourceRegex: `^${config.basePath}${route.sourceRegex.slice(localizedPattern.length)}`,
      destination: withoutLocaleGroup(
        `${config.basePath}${destination.slice(localizedDestination.length)}`,
      ),
    };
  });
}

/**
 * A destination with every reference to a group by its place moved down one, for a pattern that
 * has lost the locale's group, its first. 16.4 names the group that captures a page's `.rsc` or
 * segment suffix by its place (`/api/[id]$3`), and collapses the route table by default, so that
 * reference is on the entry that answers the API route itself. Left as it was, it named a group
 * past the last, which the router leaves in the destination: the page it named was `/api/[id]$3`,
 * which no build has, and the request matched no route at all.
 */
function withoutLocaleGroup(destination: string): string {
  return destination.replaceAll(POSITIONAL_REFERENCE, (reference: string, place: string) =>
    Number(place) > 1 ? `$${String(Number(place) - 1)}` : reference,
  );
}

/** The manifest this isolate read, and the store built over it: each made once, on first use. */
const shared: { manifest: ManifestHead | undefined; store: Store | undefined } = {
  manifest: undefined,
  store: undefined,
};

/**
 * The manifest this Function carries: whole in the app Function, and in the middleware Function
 * its head alone — the fields the adapter writes it from (`MANIFEST_HEAD_KEYS`), which are all that
 * is typed here. Its prerenders, where it has them, are written packed (`packPrerenders`): they are
 * put back as they were before anything reads them.
 */
function readManifest(): ManifestHead {
  if (shared.manifest === undefined) {
    const manifest = JSON.parse(
      new TextDecoder().decode(readBundleFile(RUNTIME_MANIFEST)),
    ) as ManifestHead & { prerenders?: unknown };
    if (manifest.prerenders !== undefined) {
      manifest.prerenders = unpackPrerenders<Prerender>(manifest.prerenders as PackedPrerenders);
    }
    shared.manifest = manifest;
  }
  return shared.manifest;
}

/**
 * The deployment's configuration, read without building the store: what a request for the
 * middleware alone reads of the manifest, and all the middleware Function's manifest holds besides
 * which deployment and build it is (`ManifestHead`).
 */
export function deploymentConfig(): ManifestHead['config'] {
  return readManifest().config;
}

/**
 * The routes and pathnames of the Pages Router pages the build rendered. Of an application with
 * `i18n` a page and its entrypoint may be spelled one with its locale and the other without, so each
 * is compared without one.
 */
function renderedPages(manifest: RuntimeManifest): ReadonlySet<string> {
  const unlocalized = (route: string): string =>
    unlocalizedRouteOf(manifest.config, route) ?? route;
  const pages = new Set(
    manifest.entrypoints
      .filter((entry) => entry.kind === 'pages')
      .map((entry) => unlocalized(entry.pathname)),
  );
  const isPage = (route: string): boolean => pages.has(unlocalized(route));
  return new Set(
    manifest.prerenders.flatMap((prerender) =>
      isPage(prerender.route) ? [prerender.route, prerender.pathname] : [],
    ),
  );
}

export function getStore(): Store {
  if (shared.store !== undefined) {
    return shared.store;
  }
  // The whole manifest: the app Function's, since nothing in the middleware Function builds one.
  const manifest = readManifest() as RuntimeManifest;
  const prerendersById = new Map(manifest.prerenders.map((prerender) => [prerender.id, prerender]));
  const prerendersByPathname = new Map(
    manifest.prerenders.map((prerender) => [prerender.pathname, prerender]),
  );
  // Every read is a copy (`readBundleFile`), and a copy kept is the blob held twice: the least
  // recently read goes first, and one larger than the whole budget is copied afresh every time.
  const blobs = new ByteLru<string, Uint8Array<ArrayBuffer>>(BLOB_MEMO_BYTES);
  const staticFiles = new Map(manifest.staticFiles.map((file) => [file.pathname, file]));
  // At most one entry for each blob the manifest names.
  const absent = new Set<string>();
  shared.store = {
    manifest,
    prerendersById,
    prerendersByPathname,
    shellsByRoute: buildShells(
      manifest.prerenders,
      documentPrerenders(manifest.prerenders, manifest.entrypoints),
    ),
    staticFiles,
    ...namedExactly(manifest),
    dynamicRoutes: routerDynamicRoutes(manifest),
    renderedPages: renderedPages(manifest),
    readBlob(sha256) {
      let bytes = blobs.get(sha256);
      if (bytes === undefined) {
        bytes = readBundleFile(`blobs/${sha256}`);
        blobs.set(sha256, bytes, bytes.byteLength);
      }
      return bytes;
    },
    tryReadBlob(sha256) {
      const held = blobs.get(sha256);
      if (held !== undefined || absent.has(sha256)) {
        return held;
      }
      const bytes = readBundleFileIfThere(`blobs/${sha256}`);
      if (bytes === undefined) {
        absent.add(sha256);
      } else {
        blobs.set(sha256, bytes, bytes.byteLength);
      }
      return bytes;
    },
  };
  return shared.store;
}

/**
 * The route the build files a page's shells under, in an application with `i18n`, for the route
 * of one of its locales: the router resolves a page to its locale's entrypoint
 * (`/en/blog/[slug]`), and the build names each of the page's prerenders after the page itself
 * (`/blog/[slug]`), with the locale in its pathname. `undefined` where the route names no locale.
 */
function unlocalizedRoute(store: Store, route: string): string | undefined {
  return unlocalizedRouteOf(store.manifest.config, route);
}

/** `route` without the locale it leads with, where the application has `i18n` and it leads with one. */
export function unlocalizedRouteOf(
  config: RuntimeManifest['config'],
  route: string,
): string | undefined {
  const { i18n, basePath } = config;
  if (i18n === null || i18n === undefined || !route.startsWith(`${basePath}/`)) {
    return undefined;
  }
  const bare = route.slice(basePath.length);
  const end = bare.indexOf('/', 1);
  const segment = end === -1 ? bare.slice(1) : bare.slice(1, end);
  if (!i18n.locales.includes(segment)) {
    return undefined;
  }
  return end === -1 ? basePath || '/' : `${basePath}${bare.slice(end)}`;
}

/**
 * A shell that stands for a class of URLs (`/items/[id]`): Next.js's fallback shell, rendered
 * with its parameters unresolved, from which a member the build did not prerender is served and
 * resumed under its own path. It is regenerated as it was made — by a render of the template
 * pathname itself, whose placeholder parameters Next.js keeps as they are rather than reading
 * them as values (`route-module.js`, `prepare`: "literal slug matches"), and defers, which gives
 * the fallback shell again. Only an App Router page renders one at request time: a Pages Router
 * `fallback: true` document is the build's alone.
 */
export function isClassShell(pathname: string, route: string): boolean {
  return placeholderSegments(pathname, route).includes(true);
}

/**
 * The document shell for a concrete URL of `route`, if the build produced one: under the route
 * itself, or, for a locale's route of an application with `i18n`, under the page's
 * (`unlocalizedRoute`). Looked up under the locale's route alone, no page of such an application
 * was served from its shell by the Function: each was rendered whole, and a `fallback: true` member
 * the build left out came back rendered where Next.js answers with the fallback
 * (`middleware-rewrites`, "should rewrite to fallback: true page successfully").
 */
export function findShell(store: Store, route: string, pathname: string): Prerender | undefined {
  let shells = store.shellsByRoute.get(route);
  if (shells === undefined) {
    const unlocalized = unlocalizedRoute(store, route);
    shells = unlocalized === undefined ? undefined : store.shellsByRoute.get(unlocalized);
  }
  if (shells === undefined) {
    return undefined;
  }
  const page = shells.pages.get(pathname);
  if (page !== undefined) {
    return page;
  }
  return shells.patterns.find(({ pattern }) => pattern.test(pathname))?.prerender;
}

/**
 * The entry a member of a route that blocks is kept under, from the class it is a member of
 * (`shell`, the route's own entry or a class narrower than it, which carries no shell):
 * `/de/fr/posts/[id]` for `/de/fr/posts/1` of `/[lang]/[region]/posts/[id]`, where the build keys
 * the route's entries on `lang` and `region` alone (`keyedParameters`), as Next.js 16.4 does when
 * `id` is one `generateStaticParams` can never provide. It is rendered from that pathname, as any
 * class shell is (`isClassShell`), and every member that shares the rest is answered from it,
 * resumed for its own `id`.
 *
 * The member itself wherever the build keys the entries on every parameter the class leaves open —
 * every release before 16.4 — and for anything else: a shell the build made, which its members are
 * served from as it is.
 */
export function completedShell(shell: Prerender, pathname: string): string {
  if (shell.body !== undefined) {
    return pathname;
  }
  const keyedBy = keyedParameters(shell.route, shell.pathname, shell.allowQuery);
  return keyedBy === undefined ? pathname : completedPathname(shell.route, keyedBy, pathname);
}

/**
 * A built PPR fallback whose output varies on unresolved root parameters needs an entry completed
 * with those values. All other built shells keep their existing entry and manual-revalidation
 * behavior. An unrelated query key cannot be represented by any pathname and remains excluded.
 *
 * Never a shell Next.js classifies as the most specific of its class (`routeType: 'shell'`), whose
 * open parameters cannot complete it into a more specific prerender; some of a `fallback`'s can
 * (`remainingPrerenderableParams`, `build/index.ts`). A root parameter always can — a build with
 * Cache Components is given a value of each (`validateParams`, `build/static-paths/app.ts`) — so a
 * root fallback is a `fallback` (`param-matching-root-params`), and is completed here.
 *
 * Next.js answers every member a `shell` stands for with the shell (`next start`), and its own
 * render of one defers the parameters the shell left open (`getStagedFallbackParams`,
 * `server/request/fallback-params.ts`). The adapter writes no keys for a `shell` with postponed
 * state, and every route key for one with nothing postponed (`build/adapter/build-complete.ts`).
 * Completed with those, each member was an entry of its own, rendered in the foreground on its
 * first request and served to everyone after: for a page that reads its parameters in the browser,
 * markup left hidden beside the page React renders there (`client-params-shallow-routing`).
 */
export function queryCompletedShell(shell: Prerender, pathname: string): string | undefined {
  if (
    shell.body === undefined ||
    shell.routeType === 'shell' ||
    (shell.allowQuery?.length ?? 0) === 0 ||
    shell.renderingMode !== 'PARTIALLY_STATIC' ||
    shell.route.includes('[...') ||
    !queryDependent(shell, shell.route, shell.pathname)
  ) {
    return undefined;
  }
  const keyedBy = keyedParameters(shell.route, shell.pathname, shell.allowQuery);
  // All parameters named is also undefined: the concrete member already identifies every key.
  const completed =
    keyedBy === undefined ? pathname : completedPathname(shell.route, keyedBy, pathname);
  return queryDependent(shell, shell.route, completed) ? undefined : completed;
}

/** The generation a shell answers from: its built entry, or the entry its member completes to. */
export function generationPathname(shell: Prerender, pathname: string): string {
  return (
    queryCompletedShell(shell, pathname) ??
    (shell.body === undefined ? completedShell(shell, pathname) : shell.pathname)
  );
}

/** The kind of code a route runs: an App Router page or handler, a Pages Router page or API. */
export function entrypointKindOf(store: Store, route: string): EntrypointKind | undefined {
  return store.manifest.entrypoints.find((entry) => entry.pathname === route)?.kind;
}
