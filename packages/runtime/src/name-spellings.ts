import { standsForClass } from '@stayingupwind/core/bundle';
import { builtNameOf } from '@stayingupwind/core/manifest';

import { redirects } from './rewritten-path.ts';
import type { Store } from './store.ts';

/**
 * The names the build gave what it built, and the escaped spellings of a path that stand for them:
 * what the router is handed to resolve by name (`pathnamesFor`, in `routing.ts`), and how a
 * spelling it resolved to is taken back to its name (`resolvedOf`, `landedRoute`).
 */

/** Any origin: a name is read as a URL's path, which is all a spelling is taken from. */
const SPELLING_BASE = 'https://names.invalid';
/** What `encodeURIComponent` leaves as it is and RFC 3986 escapes in a value. */
const SUB_DELIMITERS = /[!'()*]/gu;
const HEX = 16;
/** An escape as the encoders write one: its hex in uppercase. */
const UPPERCASE_ESCAPE = /%[0-9A-F]{2}/gu;

/** Each store's pages of their own (`ownPages`). */
const ownPagesOf = new WeakMap<Store, ReadonlySet<string>>();

/** The pathnames of a store's entrypoints that are no template: its pages of their own. */
function ownPages(store: Store): ReadonlySet<string> {
  let pages = ownPagesOf.get(store);
  if (pages === undefined) {
    pages = new Set(
      store.manifest.entrypoints
        .map((entry) => entry.pathname)
        .filter((pathname) => !isTemplate(pathname)),
    );
    ownPagesOf.set(store, pages);
  }
  return pages;
}

/** Whether a name is a file of the build that is no prerender, by either spelling of the slash. */
function isFile(store: Store, name: string): boolean {
  const unslashed = store.slashSpellings.get(name) ?? name;
  return store.staticFiles.has(unslashed) && !store.prerendersByPathname.has(unslashed);
}

/** Whether a name is a page of its own: an entrypoint that is no template, by either spelling. */
function isOwnPage(store: Store, name: string): boolean {
  return ownPages(store).has(withoutTrailingSlash(name));
}

/**
 * Of a pathname with an escaped delimiter in it, where its readings differ, the name Next.js's
 * filesystem check finds first among `names` (`has`), ahead of any dynamic route (`getItem`,
 * `server/lib/router-utils/filesystem.ts`): a file of the build, and then a page of its own, each
 * as spelled and then decoded whole, and each also without a trailing slash, which the check takes
 * off before it looks — a file named with an extension has no name behind the slash
 * (`/docs%2Frobots.txt/` is `/docs/robots.txt`). `undefined` where none is one, and a member is
 * found by its route.
 */
function foundFirst(
  store: Store,
  pathname: string,
  decoded: string | undefined,
  has: (name: string) => boolean,
): string | undefined {
  const named = [
    ...new Set(
      [pathname, decoded].flatMap((name) =>
        name === undefined ? [] : [name, withoutTrailingSlash(name)],
      ),
    ),
  ].filter((name) => has(name));
  return named.find((name) => isFile(store, name)) ?? named.find((name) => isOwnPage(store, name));
}

/**
 * The name the build gave the prerender a pathname asks for. Next.js names a prerendered member by
 * its parameters' own characters, escaping only a delimiter (`/sticks & stones`, `/記事`,
 * `/a%2Fb` for the value `a/b`; `build/static-paths/app.ts`), and a request carries them escaped
 * (`/sticks%20%26%20stones`). A pathname that names a prerender as it came, or has nothing to
 * decode, is its own name, and one decoded is the next. Where an escaped delimiter makes the
 * readings differ, the order is Next.js's: a page of its own as spelled and then decoded whole
 * (`foundFirst`), ahead of a member as spelled or by its built name (`builtNameOf`), each segment
 * decoded with an escaped slash kept inside it. Decoded whole for a member, `/docs/a%2Fb` was
 * looked up as the member `/docs/a/b` of another route.
 */
export function prerenderedName(store: Store, pathname: string): string {
  if (!pathname.includes('%')) {
    return pathname;
  }
  const prerenders = store.prerendersByPathname;
  const built = builtNameOf(pathname);
  const decoded = decodedOnce(pathname);
  const first =
    decoded === built
      ? undefined
      : foundFirst(store, pathname, decoded, (name) => prerenders.has(name));
  if (first !== undefined) {
    return first;
  }
  if (prerenders.has(pathname)) {
    return pathname;
  }
  return built !== undefined && prerenders.has(built) ? built : pathname;
}

/**
 * The name the build gave a pathname a request spells escaped, where the router is handed names
 * alone (`routerPathnames`) and matches them as they are: `/sticks%20%26%20stones` is the build's
 * `/sticks & stones`. Where no delimiter is escaped, the name is the path decoded, unless the path
 * is a name itself. Where one is, the readings differ, and the name is the one Next.js finds
 * first: a page of its own or a file, as spelled and then decoded whole (`foundFirst`), ahead of a
 * member as spelled or by its built name (`builtNameOf`), an escaped slash inside its segment —
 * `/docs/a%2fb` is `/docs/a%2Fb`, the member `a/b`; `/docs/c%2Fd` no member of a route at
 * `/docs/c/d`; and `/docs/a%2Fb` the page `/docs/a/b` where that is a page of its own, though the
 * member `/docs/a%2Fb` is named so too. `undefined` where the spelling names itself, or nothing.
 */
export function escapedNameOf(store: Store, pathname: string): string | undefined {
  if (!pathname.includes('%')) {
    return undefined;
  }
  const has = (name: string): boolean => store.pathnames.includes(name);
  const built = builtNameOf(pathname);
  const decoded = decodedOnce(pathname);
  const first = decoded === built ? undefined : foundFirst(store, pathname, decoded, has);
  if (first !== undefined) {
    return first === pathname ? undefined : first;
  }
  if (has(pathname)) {
    return undefined;
  }
  return built !== undefined && built !== pathname && has(built) ? built : undefined;
}

/** What the build named, by kind: the names a file of `public/` is told apart from (`isEscapedFile`). */
interface Named {
  readonly entrypoints: ReadonlySet<string>;
  readonly prerenders: ReadonlyMap<string, unknown>;
  readonly files: ReadonlyMap<string, unknown>;
}

/** The router's names for each store, with their escaped spellings (`namesWithSpellings`). */
const spelledNames = new WeakMap<Store, string[]>();

/**
 * The store's names, each followed by the spellings of it that a path is written in escaped: what
 * a URL makes of a name with a character a path cannot carry as it is, and the name with each
 * segment escaped, which is how a rewrite's destination names one (`/en/closed/hello%20world`,
 * `/en/closed/100%25`) — and each rewrite's path written out in full that spells one, as it is
 * written (`writtenDestinations`). A request that spells a name escaped brings its own spelling
 * (`pathnamesFor`); a rewrite rewrites to one, and the router took it for no name: the member a
 * rewrite named answered 404 where the same path asked for directly was served
 * (`param-matching-routing`). The store's own array where no name has another spelling.
 */
export function namesWithSpellings(store: Store): string[] {
  const known = spelledNames.get(store);
  if (known !== undefined) {
    return known;
  }
  const offered = new Set(store.pathnames);
  // Counted before anything is added: the store's own array may name a page twice.
  const counted = offered.size;
  // A dynamic route's own name — its entrypoint's, `[` and all — is no path anything is asked for
  // or rewritten to. A page whose value holds a bracket (`/blog/[post3]`, which `getStaticPaths`
  // and `generateStaticParams` may name) is a name like any other, and so is one whose value is
  // spelled as its own placeholder, which shares the template's name (`/blog/[post]` of
  // `/blog/[post]`): the build says it is a page and not the class (`standsForClass`).
  // A class a prerender stands for — a narrower class the build named by name
  // (`/shop/t1/[item]` of `/shop/[team]/[item]`) — is no page either.
  const pages = new Set<string>();
  const classes = new Set<string>();
  // Read off the store's own index of them, which every store has.
  for (const prerender of store.prerendersByPathname.values()) {
    (standsForClass(prerender) ? classes : pages).add(prerender.pathname);
  }
  const entrypoints = new Set(store.manifest.entrypoints.map((entry) => entry.pathname));
  const templates = new Set(
    [...entrypoints, ...classes].filter((pathname) => isTemplate(pathname) && !pages.has(pathname)),
  );
  const named = { entrypoints, prerenders: store.prerendersByPathname, files: store.staticFiles };
  // The image endpoint is the path the configuration spells, a URL's spelling already; it is
  // classified by that spelling alone (`images/classify.ts`), and an escape of it names nothing.
  const images = store.manifest.config.images?.path;
  const spelled = new Set<string>();
  for (const name of store.pathnames) {
    // A file of `public/` is named as a URL spells it already (`/foo%20bar.txt`), and an escape of
    // that spelling (`/foo%2520bar.txt`) is the file's name escaped twice, which names no file.
    if (
      name === images ||
      templates.has(withoutTrailingSlash(name)) ||
      isEscapedFile(named, name)
    ) {
      continue;
    }
    spelled.add(name);
    for (const spelling of spellingsOf(name)) {
      offered.add(spelling);
    }
  }
  // A rewrite's path written out in full is a spelling as it is written, whatever case its escapes
  // are in and whatever they escape (`/docs/%e8%A8%98%E4%BA%8B`, `/docs/caf%65`), and no encoder's
  // spelling need be it: one that names a name spelled above, as Next.js finds it
  // (`escapedNameOf`), is offered as it stands — `/docs/a%2fb` for the member `/docs/a%2Fb`,
  // never for the member `/docs/a/b` of another route.
  for (const path of writtenDestinations(store)) {
    const name = escapedNameOf(store, path);
    if (name !== undefined && spelled.has(name)) {
      offered.add(path);
    }
  }
  const names = offered.size === counted ? store.pathnames : [...offered];
  spelledNames.set(store, names);
  return names;
}

/**
 * What a URL makes of `name`, `name` with each segment escaped, and the same escaped as RFC 3986
 * escapes data — `!`, `'`, `(`, `)` and `*` as well, which `encodeURIComponent` leaves be
 * (`/docs/rock%27n` for `/docs/rock'n`) — each in uppercase hex and in lowercase: those that are
 * other spellings of it. An escape of a character no encoder escapes (`%65` for `e`), or hex of
 * mixed case, is none of these; a destination written so is offered as it is written.
 */
function spellingsOf(name: string): string[] {
  let asUrl: string;
  let segments: string[];
  try {
    asUrl = new URL(name, SPELLING_BASE).pathname;
    segments = name.split('/').map((segment) => encodeURIComponent(segment));
  } catch {
    // A name no URL can spell — a lone surrogate in it — is offered as it is and nothing more.
    return [];
  }
  const escaped = segments.join('/');
  const strictly = segments
    .map((segment) => segment.replaceAll(SUB_DELIMITERS, (character) => percentOf(character)))
    .join('/');
  const encoded = [asUrl, escaped, strictly];
  // Each in uppercase hex, as the encoders write it, and in lowercase, which a destination may be
  // written in as readily (`/docs/%e8%a8%98%e4%ba%8b` for `/docs/記事`): the router compares the
  // path it ended on with each name as it is.
  const spellings = new Set(encoded);
  for (const spelling of encoded) {
    spellings.add(spelling.replaceAll(UPPERCASE_ESCAPE, (escape) => escape.toLowerCase()));
  }
  return [...spellings].filter((spelling) => spelling !== name && spells(spelling, name));
}

/**
 * The path of each rewrite whose path is written out in full — on this origin, nothing of the request
 * put in it (`$1`, `$slug`) — where it holds an escape: as the router sets it on the URL it rewrites
 * (`applyDestination`), and so as it compares it with each name — a fragment included, which the
 * router sets in the path escaped (`%23`). A path a request's values are put in is spelled by the
 * request, and is offered the encoders' spellings alone (`spellingsOf`).
 */
function writtenDestinations(store: Store): string[] {
  const { routing } = store.manifest;
  const written: string[] = [];
  for (const table of [
    routing.beforeMiddleware,
    routing.beforeFiles,
    routing.afterFiles,
    routing.fallback,
  ]) {
    for (const route of table) {
      const { destination } = route;
      if (destination === undefined || !destination.startsWith('/') || redirects(route)) {
        continue;
      }
      // The path alone, as the router takes it: a request's values put in the query alone
      // (`?from=$slug`) leave the path as it is written.
      const [path = ''] = destination.split('?', 1);
      if (path.includes('%') && !path.includes('$')) {
        const url = new URL(SPELLING_BASE);
        url.pathname = path;
        written.push(url.pathname);
      }
    }
  }
  return written;
}

/** `path` decoded once, or `undefined` where an escape in it is no escape. */
function decodedOnce(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

function percentOf(character: string): string {
  return `%${(character.codePointAt(0) ?? 0).toString(HEX).toUpperCase()}`;
}

/**
 * Whether `spelling` is read as `name`: its built name (`builtNameOf`), as `escapedNameOf` takes a
 * spelling back — decoded once, and never into another segment.
 */
function spells(spelling: string, name: string): boolean {
  return builtNameOf(spelling) === name;
}

/**
 * A file of `public/`, named as a URL spells it, whose name is a spelling of another: a static file
 * no page or prerender is named after, and whose name is exactly what the adapter names such a file
 * — each segment of the file's own name escaped (`encodeURIComponent`), which turns no unreserved
 * character into an escape. A page the build wrote as a file is named by its own characters, a
 * literal escape among them (`/docs/%41`, which no file of `public/` is named), and keeps its
 * spellings, in an export with no entrypoint to say so too.
 */
function isEscapedFile(named: Named, name: string): boolean {
  const file = withoutTrailingSlash(name);
  if (
    !name.includes('%') ||
    !named.files.has(file) ||
    named.entrypoints.has(file) ||
    named.prerenders.has(file)
  ) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(file);
    return decoded !== file && escapedSegments(decoded) === file;
  } catch {
    return false;
  }
}

function escapedSegments(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** A route's own name in brackets (`/[id]`): a dynamic route's entrypoint is named so. */
function isTemplate(pathname: string): boolean {
  return pathname.includes('[');
}

function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}
