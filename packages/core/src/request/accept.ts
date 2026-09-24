import type { ShellEncoding } from '../artifact/artifact.ts';

/**
 * `Accept` negotiation for the document decision.
 *
 * A request that lists HTML with `q=0` is saying it does not want HTML, and the origin may answer
 * with something else entirely or refuse. Serving it a proved shell would change what the app
 * returns, so the quality value decides rather than the presence of a substring.
 */

const HTML_TYPE = 'text/html';
const HTML_RANGE = 'text/*';
const ANY_RANGE = '*/*';
/** Most specific match wins (RFC 9110 §12.5.1), so ranges are ranked before their quality is read. */
const ANY_RANK = 1;
const SUBTYPE_WILDCARD_RANK = 2;
const EXACT_RANK = 3;
const RANGE_RANK: ReadonlyMap<string, number> = new Map([
  [ANY_RANGE, ANY_RANK],
  [HTML_RANGE, SUBTYPE_WILDCARD_RANK],
  [HTML_TYPE, EXACT_RANK],
]);

function qualityOf(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const [name, value] = parameter.split('=', 2);
    if (name?.trim().toLowerCase() === 'q') {
      const quality = Number.parseFloat(value ?? '');
      return Number.isNaN(quality) ? 1 : quality;
    }
  }
  return 1;
}

/**
 * Whether the header allows an HTML document. A missing header expresses no preference, and a
 * header that never mentions HTML or a wildcard is asking for something this edge cannot decide.
 */
export function acceptsHtml(accept: string | null): boolean {
  if (accept === null) {
    return true;
  }
  let bestRank = 0;
  let bestQuality = 0;
  for (const entry of accept.split(',')) {
    const [range, ...parameters] = entry.trim().split(';');
    const rank = RANGE_RANK.get(range?.trim().toLowerCase() ?? '');
    if (rank === undefined || rank < bestRank) {
      continue;
    }
    const quality = qualityOf(parameters);
    // A range that appears twice keeps the best offer it made. Taking the last would let a header
    // that both asks for HTML and refuses it read as a refusal, on nothing but the order.
    bestQuality = rank > bestRank ? quality : Math.max(bestQuality, quality);
    bestRank = rank;
  }
  return bestRank > 0 && bestQuality > 0;
}

const ANY_CODING = '*';
const IDENTITY_CODING = 'identity';
/** Ranked so that a tie on quality prefers the smaller document. */
const CODING_PREFERENCE: readonly ShellEncoding[] = ['br', 'gzip'];

/** The quality the header assigns to each coding it names, lower-cased; `*` is one of them. */
function codingQualities(acceptEncoding: string): Map<string, number> {
  const qualities = new Map<string, number>();
  for (const entry of acceptEncoding.split(',')) {
    const [coding, ...parameters] = entry.trim().split(';');
    const name = coding?.trim().toLowerCase() ?? '';
    if (name === '') {
      continue;
    }
    const quality = qualityOf(parameters);
    // A coding listed twice keeps its best offer, for the same reason as a repeated media range.
    qualities.set(name, Math.max(qualities.get(name) ?? 0, quality));
  }
  return qualities;
}

/**
 * Which of the shell's pre-compressed renderings to send, if any (RFC 9110 §12.5.3).
 *
 * A request with no header, or one that scores every offered coding zero, gets identity. `*`
 * stands for any coding the header does not name, identity included. A rendering is sent when the
 * client rates it at least as high as it rates identity: a client that names identity, or covers
 * it with `*`, has said how much it wants the bytes as they are, and one that does not has
 * expressed no preference — it merely accepts them. (The RFC makes an unnamed identity acceptable;
 * it gives it no quality to rank by. Reading it as 1 would send `br;q=0.1` the bytes as they are,
 * against a client that has just said it takes brotli.) Ties go to the rendering, and between
 * renderings to brotli, the smaller one. Identity is never refused: a client that scores it zero
 * but accepts nothing on offer still gets the document rather than a 406, since the whole point of
 * this response is that it is already on its way.
 */
export function negotiateContentEncoding(
  acceptEncoding: string | null,
  offered: ReadonlySet<ShellEncoding>,
): ShellEncoding | typeof IDENTITY_CODING {
  if (acceptEncoding === null || offered.size === 0) {
    return IDENTITY_CODING;
  }
  const qualities = codingQualities(acceptEncoding);
  const wildcard = qualities.get(ANY_CODING) ?? 0;
  let best: ShellEncoding | typeof IDENTITY_CODING = IDENTITY_CODING;
  let bestQuality = qualities.get(IDENTITY_CODING) ?? wildcard;
  for (const coding of CODING_PREFERENCE) {
    if (!offered.has(coding)) {
      continue;
    }
    const quality = qualities.get(coding) ?? wildcard;
    const beats = best === IDENTITY_CODING ? quality >= bestQuality : quality > bestQuality;
    if (beats && quality > 0) {
      best = coding;
      bestQuality = quality;
    }
  }
  return best;
}
