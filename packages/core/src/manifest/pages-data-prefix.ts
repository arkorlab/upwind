/**
 * Where a manifest says a Pages Router page's props are asked for, spelled in one place: by the
 * writer that names it from a build's base path and id (`buildProjectManifest`), and by the reader
 * that compares a request with it (`pageOfPagesData`). The prefix is never taken apart again — a
 * base path may itself hold `/_next/data/`, and a build id may be more than one segment — so the
 * manifest names the base path beside it (`pagesDataBasePath`).
 */

/** What a build's data requests are asked under, below its base path and above its build's id. */
export const PAGES_DATA_SEGMENT = '/_next/data/';

/** Only for its parser: a path is spelled the same under any origin. */
const ANY_ORIGIN = 'https://pages-data.invalid';

/**
 * A path as a request's URL spells it: percent-encoded as a URL's path is, with its dot segments
 * resolved. Set as a URL's path rather than parsed as a URL, so that a `?` or a `#` in it is part of
 * the path — encoded — and ends nothing.
 */
export function requestSpelling(path: string): string {
  const url = new URL(ANY_ORIGIN);
  url.pathname = path;
  return url.pathname;
}

/** A path with its escapes decoded; `undefined` for one that does not decode. */
export function decodedPath(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

/**
 * Whether a request can ask for a path by its name as the build wrote it: a URL gives that name no
 * other than its own, percent-encoded. A dot segment (`/a/../b`), a backslash, an escape already in
 * it — a URL resolves or rewrites each, so a request never names what the build wrote under such a
 * name, and a prefix spelled from it (`pagesDataPrefixOf`) names nothing the build wrote.
 */
function spellsAsWritten(path: string): boolean {
  return decodedPath(requestSpelling(path)) === path;
}

/**
 * Where a host is asked for a Pages Router page's props, for a manifest (`pagesDataPrefix`):
 * `<basePath>/_next/data/<buildId>`, with no slash after, as a request's URL spells it — which is
 * what a request's pathname is compared with.
 */
export function pagesDataPrefixOf(buildId: string, basePath: string): string {
  return requestSpelling(`${basePath}${PAGES_DATA_SEGMENT}${buildId}`);
}

/** A base path as Next.js takes one: empty, or `/…` with no empty segment and no slash after. */
function isBasePath(basePath: string): boolean {
  return (
    basePath === '' ||
    (basePath.startsWith('/') && !basePath.endsWith('/') && !basePath.includes('//'))
  );
}

/**
 * A build id a prefix can carry: not empty, and with no empty segment where `generateBuildId` made
 * it of more than one — Next.js joins it into the URL as it is (`release/123`).
 */
function isBuildId(buildId: string): boolean {
  return (
    buildId !== '' && !buildId.startsWith('/') && !buildId.endsWith('/') && !buildId.includes('//')
  );
}

/**
 * Whether a base path and a build id name a prefix a request asks under: one a prefix can carry,
 * whose name a request spells as the build wrote it (`spellsAsWritten`) — so that what the build
 * named under it is what a request names.
 */
export function namesPagesDataPrefix(basePath: string, buildId: string): boolean {
  return (
    isBasePath(basePath) &&
    isBuildId(buildId) &&
    spellsAsWritten(`${basePath}${PAGES_DATA_SEGMENT}${buildId}`)
  );
}
