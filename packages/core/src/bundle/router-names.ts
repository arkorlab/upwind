import { builtNameOf } from '../manifest/built-names.ts';
import { decodedPath } from '../manifest/pages-data-prefix.ts';
import { resolvedByName } from './spelling.ts';

/**
 * The names the deployment's router is handed to resolve exactly, read once for the runtime, which
 * hands them to `@next/routing`, and for the checks a bundle's gates are held to, which follow that
 * router to where it lands a request (`gate-routes.ts`): the two read a build alike.
 */

/** A prerender, as far as whether the router resolves it by name (`resolvedByName`). */
type NamedPrerender = Parameters<typeof resolvedByName>[0];

/** What of a build names what its router resolves exactly. */
export interface RouterNamed {
  readonly config: {
    readonly basePath: string;
    readonly trailingSlash: boolean;
    readonly i18n?: { readonly locales: readonly string[] } | null | undefined;
    readonly images?: { readonly path: string } | undefined;
  };
  readonly entrypoints: readonly { readonly pathname: string }[];
  readonly prerenders: readonly NamedPrerender[];
  readonly staticFiles: readonly { readonly pathname: string }[];
}

/** What the router is handed to resolve exactly, and which of it is a name spelled with a slash. */
export interface RouterNames {
  readonly pathnames: string[];
  /** Each spelling among `pathnames` with a trailing slash, to the name it spells. */
  readonly slashSpellings: ReadonlyMap<string, string>;
}

const LAST_SEGMENT_NAMES_NO_FILE = /\/[^./]+$/u;

/**
 * Whether Next.js spells `pathname` with a trailing slash under `trailingSlash`: a path whose last
 * segment names no file, which its redirect gives the slash. A template is never asked for by
 * name with one: a dynamic route's matcher takes the slash itself.
 */
function takesTrailingSlash(pathname: string): boolean {
  return LAST_SEGMENT_NAMES_NO_FILE.test(pathname) && !pathname.includes('[');
}

/**
 * The pages named with a trailing slash that are the page without it: every page that takes one,
 * where the application keeps its pages there; and, in an application with `i18n` that does not,
 * the root of each locale. `@next/routing` routes the application's root as `/<locale>/`, the
 * default locale put in front of the root's own slash, and Next.js serves `/<locale>/` as that
 * locale's root when no redirect takes the slash off first (`internalRedirect`).
 */
function slashSpellingsOf(
  config: RouterNamed['config'],
  named: readonly string[],
): Map<string, string> {
  if (config.trailingSlash) {
    return new Map(
      named
        .filter((pathname) => takesTrailingSlash(pathname))
        .map((pathname) => [`${pathname}/`, pathname] as const),
    );
  }
  const roots = new Set(
    (config.i18n?.locales ?? []).map((locale) => `${config.basePath}/${locale}`),
  );
  return new Map(
    named.filter((pathname) => roots.has(pathname)).map((pathname) => [`${pathname}/`, pathname]),
  );
}

/**
 * What the router resolves exactly: the pages, the Pages Router's data routes (which its dynamic
 * routes rewrite to), the shipped files, the spellings of those with a trailing slash that are the
 * page without it (`slashSpellingsOf`), and the optimizer's own path, which Next.js answers ahead
 * of its rewrites and dynamic routes as a file of its own. Of the prerenders, those it resolves by
 * name (`resolvedByName`): naming one makes it the route a request resolves to, which is not the
 * route the build filed its shell under, and the runtime puts that back (`renderedBy`), so a member
 * of a closed route is still served from its shell and resumed rather than rendered whole.
 */
export function routerPathnames(build: RouterNamed): RouterNames {
  const named = [
    ...build.entrypoints.map((entry) => entry.pathname),
    ...build.prerenders
      .filter((prerender) => resolvedByName(prerender, build.config.basePath))
      .map((prerender) => prerender.pathname),
    ...build.staticFiles.map((file) => file.pathname),
  ];
  const slashSpellings = slashSpellingsOf(build.config, named);
  return {
    pathnames: [
      ...named,
      ...slashSpellings.keys(),
      ...(build.config.images === undefined ? [] : [build.config.images.path]),
    ],
    slashSpellings,
  };
}

/** A path without the one slash it may end in, the root's aside. */
function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * The names among `names` (`routerPathnames`) the router may resolve `path` as, other than `path`
 * itself. Beside those names, the runtime hands the router their escaped spellings
 * (`namesWithSpellings`) — a rewrite's destination written out in full among them — and the path
 * a request asks by where that spells one (`pathnamesFor`); and whatever it resolves, it serves as
 * the name it reads it back as (`escapedNameOf`), which a page of its own or a file the path also
 * spells may be, whether or not the path is a name itself. Each such spelling holds an escape, and
 * is read back decoded whole or by the name Next.js builds a member under (`builtNameOf`), with or
 * without a trailing slash: so is a path here, and every name it may be read as is said — whether
 * the router is handed it depends on the request, and on which of them it finds first. None for a
 * path with no escape, which the router resolves only as it is.
 */
export function namesSpelledBy(path: string, names: ReadonlySet<string>): string[] {
  if (!path.includes('%')) {
    return [];
  }
  const readings = [path, decodedPath(path), builtNameOf(path)].flatMap((reading) =>
    reading === undefined ? [] : [reading, withoutTrailingSlash(reading)],
  );
  return [...new Set(readings)].filter((reading) => reading !== path && names.has(reading));
}
