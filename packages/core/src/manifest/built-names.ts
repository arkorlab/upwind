/**
 * The name Next.js gives what it builds, read off the path a request asks by: one reading for the
 * edge's lookups of what the build named and for the deployment's runtime, so that the two find the
 * same page by the same path.
 */

/** What `escapePathDelimiters` escapes in a page's name: a delimiter, or one already escaped. */
const PATH_DELIMITER = /[/#?\\]|%(?:2f|23|3f|5c)/giu;

/**
 * A segment of a page's name as Next.js names a page it builds: decoded, with what would delimit a
 * path escaped back (`escapePathDelimiters(…, true)`), so that a parameter's `/` stays inside its
 * segment.
 */
export function builtSegment(decoded: string): string {
  return decoded.replaceAll(PATH_DELIMITER, (found) => encodeURIComponent(found));
}

/**
 * The name Next.js builds what a path asks for under: each segment decoded and built back
 * (`builtSegment`), as `getStaticPaths` names an entry it is handed as a path
 * (`build/static-paths/pages.ts`) and as a dynamic route reads a member's value — with its `/`
 * inside the segment. `/docs/a%2fb` asks for `/docs/a%2Fb`, the member whose value is `a/b`, and
 * never for `/docs/a/b`, which decoding the path whole read it as. `undefined` where a segment does
 * not decode.
 */
export function builtNameOf(path: string): string | undefined {
  try {
    return path
      .split('/')
      .map((segment) => builtSegment(decodeURIComponent(segment)))
      .join('/');
  } catch {
    return undefined;
  }
}
