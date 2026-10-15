import type { SpelledPrefix } from './schema.ts';

/**
 * What Next.js's router reads of a path as it is written, before it decodes anything: the base
 * path, which it compares with the path as written (`pathHasPrefix`), and in an application with
 * `i18n`, the locale behind it, which it compares as written too, case aside
 * (`normalizeLocalePath`). A path that spells either escaped is not under it: the router finds no
 * base path in front of `/b%61se/about`, and no locale in front of `/%65n/about` — which it routes
 * as `/en/%65n/about`, the default locale put in front, a page of no name the build gave.
 */

/** Only ever used to read a base path as a request's URL writes it. */
const SPELLING_ORIGIN = 'https://spelling.invalid';

/**
 * A base path as a request's URL writes it — a character past ASCII escaped, as a browser escapes
 * it — which is the spelling the router compares a path as written with.
 */
function spelledBasePath(basePath: string): string {
  return new URL(basePath, SPELLING_ORIGIN).pathname;
}

/** The first segment of a path, or `undefined` for one that is not absolute. */
function firstSegment(path: string): string | undefined {
  return path.startsWith('/') ? path.slice(1).split('/', 1)[0] : undefined;
}

/**
 * Whether a request that spells its path `pathname` names `name`, which a reading of the path
 * that decodes it found, as Next.js's router does: where `name` is under the base path, the path
 * writes the base path in front, as a URL writes it; and where `name` then begins with a locale,
 * the path writes that locale behind it, as it is, case aside. Escaped, either one names nothing
 * the router finds (`/b%61se/about`, `/%65n/about`, `/en%2Fabout`). The rest of the path is the
 * reading's to decode. `true` where `prefix` is absent: a manifest from before it was published is
 * read as it was, a path decoded whole.
 */
export function spellsPrefixOf(
  prefix: SpelledPrefix | undefined,
  pathname: string,
  name: string,
): boolean {
  if (prefix === undefined) {
    return true;
  }
  const { basePath, locales } = prefix;
  let rest = name;
  let written = pathname;
  if (basePath !== '' && (name === basePath || name.startsWith(`${basePath}/`))) {
    const spelled = spelledBasePath(basePath);
    if (pathname !== spelled && !pathname.startsWith(`${spelled}/`)) {
      return false;
    }
    rest = name.slice(basePath.length);
    written = pathname.slice(spelled.length);
  }
  const locale = firstSegment(rest)?.toLowerCase();
  if (
    locales === undefined ||
    locale === undefined ||
    locales.every((one) => one.toLowerCase() !== locale)
  ) {
    return true;
  }
  return firstSegment(written)?.toLowerCase() === locale;
}
