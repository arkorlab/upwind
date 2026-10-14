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

/**
 * What a URL reads as its own in a path that a name may hold as it is: a `%`, which would start an
 * escape, a `#` or a `?`, which would end the path, and a `\`, which it reads as a `/`.
 */
const URL_SYNTAX = /[%#?\\]/gu;

/**
 * The same, of a page's name, but for a `%` that starts an escape `builtSegment` wrote (`%2F` for a
 * parameter's `/`, `%252F` for an escape that stood in its value as it is): the name's own.
 */
const NAME_SYNTAX = /%(?!(?:25)?(?:2f|23|3f|5c))|[#?\\]/giu;

/**
 * A file's path as a request names it: what a URL reads as its own escaped (`URL_SYNTAX`), and the
 * rest left to the URL it is written into, which escapes a space or a character past ASCII as a
 * browser's does. Read back decoded whole, it is `path` again, as the edge finds a file the build
 * shipped (`staticFileKey`). Written into a URL as it is, `/50% off.png` asks for no file: its `%`
 * and the escape its space becomes read as one escape that is none.
 */
export function escapedPathOf(path: string): string {
  return path.replaceAll(URL_SYNTAX, (found) => encodeURIComponent(found));
}

/**
 * The path a request asks for the page Next.js built under `name` by: what a URL reads as its own
 * escaped (`NAME_SYNTAX`) — a `%` that stood in a parameter's value as it is, above all — and the
 * rest left to the URL it is written into, as a browser leaves a link's. Read back (`builtNameOf`),
 * it is the name again. Written into a URL as it is, a name asks for another page, or for none:
 * `/docs/100%` holds a `%` that starts no escape, which no reading of the path decodes.
 */
export function requestPathOf(name: string): string {
  return name.replaceAll(NAME_SYNTAX, (found) => encodeURIComponent(found));
}
