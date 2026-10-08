import type { Store } from './store.ts';

/**
 * The names the build gave what it built, and the escaped spellings of a path that stand for them:
 * what the router is handed to resolve by name (`pathnamesFor`, in `routing.ts`), and how a
 * spelling it resolved to is taken back to its name (`resolvedOf`, `landedRoute`).
 */

/** Any origin: a name is read as a URL's path, which is all a spelling is taken from. */
const SPELLING_BASE = 'https://names.invalid';

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
  // and `generateStaticParams` may name) is a name like any other.
  const templates = new Set(
    store.manifest.entrypoints
      .map((entry) => entry.pathname)
      .filter((pathname) => isTemplate(pathname)),
  );
  for (const name of store.pathnames) {
    if (templates.has(withoutTrailingSlash(name))) {
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

/** What a URL makes of `name`, and `name` with each segment escaped: those that are other spellings of it. */
function spellingsOf(name: string): string[] {
  const asUrl = new URL(name, SPELLING_BASE).pathname;
  const escaped = name
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return [asUrl, escaped].filter((spelling) => spelling !== name && spells(spelling, name));
}

/** Whether `spelling`, decoded once, is `name`: a spelling is never decoded twice (`escapedNameOf`). */
function spells(spelling: string, name: string): boolean {
  try {
    return decodeURIComponent(spelling) === name;
  } catch {
    return false;
  }
}

/** A route's own name in brackets (`/[id]`): a dynamic route's entrypoint is named so. */
function isTemplate(pathname: string): boolean {
  return pathname.includes('[');
}

function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}
