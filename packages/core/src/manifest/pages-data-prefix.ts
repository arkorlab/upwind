/**
 * A manifest's `pagesDataPrefix` taken apart, in the one place its shape is read: by the reader
 * that names a page from it (`pageOfPagesData`) and by the writer that refuses one the reader could
 * not take apart (`buildProjectManifest`).
 */

/** What a build's data requests are asked under, below its base path and above its build's id. */
export const PAGES_DATA_SEGMENT = '/_next/data/';

/** A base path as Next.js takes one: empty, or `/…` with no empty segment and no slash after. */
function isBasePath(basePath: string): boolean {
  return (
    basePath === '' ||
    (basePath.startsWith('/') && !basePath.endsWith('/') && !basePath.includes('//'))
  );
}

/**
 * The base path a prefix `<basePath>/_next/data/<buildId>` is under, `''` for none, or `undefined`
 * for a prefix of any other shape. The base path ends at the first `/_next/data/`, which Next.js
 * keeps for itself under it; the build id is the rest, which may be more than one segment —
 * `generateBuildId` may return `release/123`, and Next.js joins it into the URL as it is — but no
 * empty one, and nothing after it.
 */
export function basePathOfPagesDataPrefix(prefix: string): string | undefined {
  const at = prefix.indexOf(PAGES_DATA_SEGMENT);
  if (at === -1) {
    return undefined;
  }
  const basePath = prefix.slice(0, at);
  const buildId = prefix.slice(at + PAGES_DATA_SEGMENT.length);
  const wellFormed =
    buildId !== '' && !buildId.startsWith('/') && !buildId.endsWith('/') && !buildId.includes('//');
  return wellFormed && isBasePath(basePath) ? basePath : undefined;
}
