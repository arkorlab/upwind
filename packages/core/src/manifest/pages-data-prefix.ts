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
 * the path — encoded, as Next.js's client encodes one in a parameter — and ends nothing.
 */
export function requestSpelling(path: string): string {
  const url = new URL(ANY_ORIGIN);
  url.pathname = path;
  return url.pathname;
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
export function isBasePath(basePath: string): boolean {
  return (
    basePath === '' ||
    (basePath.startsWith('/') && !basePath.endsWith('/') && !basePath.includes('//'))
  );
}

/**
 * A build id a prefix can carry: not empty, and with no empty segment where `generateBuildId` made
 * it of more than one — Next.js joins it into the URL as it is (`release/123`).
 */
export function isBuildId(buildId: string): boolean {
  return (
    buildId !== '' && !buildId.startsWith('/') && !buildId.endsWith('/') && !buildId.includes('//')
  );
}
