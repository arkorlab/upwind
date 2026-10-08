import { standsForClass } from '@stayingupwind/core/bundle';

import { entrypointKindOf, type Store } from './store.ts';

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

/**
 * The name the build gave the prerender a pathname asks for. Next.js names a prerendered member by
 * its parameters' own characters, escaping only a delimiter (`/sticks & stones`, `/記事`;
 * `build/static-paths/app.ts`), and a request carries them escaped (`/sticks%20%26%20stones`).
 * Its filesystem check looks a path up as it came and then decoded (`getItem`), and so does this:
 * a pathname that names a prerender as it came, or has nothing to decode, is its own name.
 */
export function prerenderedName(store: Store, pathname: string): string {
  if (!pathname.includes('%') || store.prerendersByPathname.has(pathname)) {
    return pathname;
  }
  try {
    const decoded = decodeURIComponent(pathname);
    return store.prerendersByPathname.has(decoded) ? decoded : pathname;
  } catch {
    return pathname;
  }
}

/**
 * The name the build gave a pathname a request spells escaped, where the router is handed names
 * alone (`routerPathnames`) and matches them as they are: `/sticks%20%26%20stones` is the build's
 * `/sticks & stones`. `undefined` where the spelling is a name itself, or decodes to none.
 */
export function escapedNameOf(store: Store, pathname: string): string | undefined {
  if (!pathname.includes('%') || store.pathnames.includes(pathname)) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  return decoded !== pathname && store.pathnames.includes(decoded) ? decoded : undefined;
}

/** The router's names for each store, with their escaped spellings (`namesWithSpellings`). */
const spelledNames = new WeakMap<Store, string[]>();

/**
 * The store's names, each followed by the spellings of it that a path is written in escaped: what
 * a URL makes of a name with a character a path cannot carry as it is, and the name with each
 * segment escaped, which is how a rewrite's destination names one (`/en/closed/hello%20world`,
 * `/en/closed/100%25`). A request that spells a name escaped brings its own spelling
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
  const named = offered.size;
  // A dynamic route's own name — its entrypoint's, `[` and all — is no path anything is asked for
  // or rewritten to. A page whose value holds a bracket (`/blog/[post3]`, which `getStaticPaths`
  // and `generateStaticParams` may name) is a name like any other, and so is one whose value is
  // spelled as its own placeholder, which shares the template's name (`/blog/[post]` of
  // `/blog/[post]`): the build says it is a page and not the class (`standsForClass`).
  const pages = new Set(
    store.manifest.prerenders
      .filter((prerender) => !standsForClass(prerender))
      .map((prerender) => prerender.pathname),
  );
  const templates = new Set(
    store.manifest.entrypoints
      .map((entry) => entry.pathname)
      .filter((pathname) => isTemplate(pathname) && !pages.has(pathname)),
  );
  for (const name of store.pathnames) {
    // A file of `public/` is named as a URL spells it already (`/foo%20bar.txt`), and an escape of
    // that spelling (`/foo%2520bar.txt`) is the file's name escaped twice, which names no file.
    if (templates.has(withoutTrailingSlash(name)) || isEscapedFile(store, name)) {
      continue;
    }
    for (const spelling of spellingsOf(name)) {
      offered.add(spelling);
    }
  }
  const names = offered.size === named ? store.pathnames : [...offered];
  spelledNames.set(store, names);
  return names;
}

/**
 * What a URL makes of `name`, `name` with each segment escaped, and the same escaped as RFC 3986
 * escapes data — `!`, `'`, `(`, `)` and `*` as well, which `encodeURIComponent` leaves be
 * (`/docs/rock%27n` for `/docs/rock'n`): those that are other spellings of it.
 */
function spellingsOf(name: string): string[] {
  const asUrl = new URL(name, SPELLING_BASE).pathname;
  const segments = name.split('/').map((segment) => encodeURIComponent(segment));
  const escaped = segments.join('/');
  const strictly = segments
    .map((segment) => segment.replaceAll(SUB_DELIMITERS, (character) => percentOf(character)))
    .join('/');
  return [...new Set([asUrl, escaped, strictly])].filter(
    (spelling) => spelling !== name && spells(spelling, name),
  );
}

function percentOf(character: string): string {
  return `%${(character.codePointAt(0) ?? 0).toString(HEX).toUpperCase()}`;
}

/** Whether `spelling`, decoded once, is `name`: a spelling is never decoded twice (`escapedNameOf`). */
function spells(spelling: string, name: string): boolean {
  try {
    return decodeURIComponent(spelling) === name;
  } catch {
    return false;
  }
}

/**
 * A file of `public/`, named as a URL spells it, whose name is a spelling of another: a static file
 * no page or prerender is named after, and whose name is exactly what the adapter names such a file
 * — each segment of the file's own name escaped (`encodeURIComponent`), which turns no unreserved
 * character into an escape. A page the build wrote as a file is named by its own characters, a
 * literal escape among them (`/docs/%41`, which no file of `public/` is named), and keeps its
 * spellings, in an export with no entrypoint to say so too.
 */
function isEscapedFile(store: Store, name: string): boolean {
  const file = withoutTrailingSlash(name);
  if (
    !name.includes('%') ||
    !store.staticFiles.has(file) ||
    entrypointKindOf(store, file) !== undefined ||
    store.prerendersByPathname.has(file)
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
