/**
 * The entity-tag lists of a request's preconditions — `If-None-Match`, `If-Match` — read as RFC 9110
 * writes them (§8.8.3, §13.1.1, §13.1.2): of the edge's own answers (`asset-upstream.ts`,
 * `static-file-conditions.ts`), and of the blob Worker's (`../blob/worker.ts`). A leaf of no import,
 * so that what imports it carries nothing else.
 */

/** The opaque tag without a `W/` prefix: `If-None-Match` uses weak comparison (RFC 9110 §13.1.2). */
function opaqueTag(validator: string): string {
  return validator.startsWith('W/') ? validator.slice('W/'.length) : validator;
}

/** Where the optional whitespace starting at `at` ends (RFC 9110 §5.6.3). */
function pastOws(header: string, at: number): number {
  let end = at;
  while (header.charAt(end) === ' ' || header.charAt(end) === '\t') {
    end += 1;
  }
  return end;
}

/** What ends an item sent without quotes. */
const BARE_TAG_END: ReadonlySet<string> = new Set([' ', '\t', '"', ',']);

/**
 * The item of a list of entity tags that starts at `at`, and where it ends; `undefined` where no
 * item can be read there. A quoted entity tag runs to its closing quote, a comma inside it being
 * the tag's own (RFC 9110 §8.8.3): `"build,1"` is one tag, not two. A `W/` before it is dropped,
 * the comparison being weak. An item without quotes — `*`, or a tag sent bare, which the comparison
 * always took as it came — runs to the next comma, space or quote.
 */
function listItemAt(
  header: string,
  at: number,
): { readonly tag: string; readonly end: number } | undefined {
  const start = header.startsWith('W/', at) ? at + 'W/'.length : at;
  if (header.charAt(start) === '"') {
    const close = header.indexOf('"', start + 1);
    return close === -1 ? undefined : { tag: header.slice(start, close + 1), end: close + 1 };
  }
  let end = start;
  while (end < header.length && !BARE_TAG_END.has(header.charAt(end))) {
    end += 1;
  }
  return end === start ? undefined : { tag: header.slice(start, end), end };
}

/**
 * The entity tags an `If-None-Match` or an `If-Match` lists, read item by item as the list's grammar
 * has them: items parted by commas, with optional whitespace and empty elements between them (RFC
 * 9110 §5.6.1). A header that is not such a list — two items with no comma between, `junk"v1"`, or a
 * quote left open — is `undefined`, and matches nothing: no 304 is made, and no `If-Match` met, by a
 * tag found inside text that is not one. Read once, left to right, whatever the header holds.
 */
function listedTags(header: string): ReadonlySet<string> | undefined {
  const tags = new Set<string>();
  let at = pastOws(header, 0);
  while (at < header.length) {
    if (header.charAt(at) === ',') {
      at = pastOws(header, at + 1);
      continue;
    }
    const item = listItemAt(header, at);
    if (item === undefined) {
      return undefined;
    }
    tags.add(item.tag);
    at = pastOws(header, item.end);
    if (at < header.length && header.charAt(at) !== ',') {
      return undefined;
    }
  }
  return tags;
}

/**
 * Whether a list of entity tags names the one the response would carry, compared weakly, or asks
 * with `*` whether there is a representation at all, which an answer about to be sent is, tagged or
 * not (RFC 9110 §13.1.2). A value that is not such a list names nothing (`listedTags`).
 */
export function listsTag(header: string, etag: string | null): boolean {
  const candidates = listedTags(header);
  if (candidates === undefined) {
    return false;
  }
  return candidates.has('*') || (etag !== null && candidates.has(opaqueTag(etag)));
}
