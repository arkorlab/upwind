/**
 * Which clients are sent the second brotli layer (`content-encoding: br, br`).
 *
 * Codings listed on one response are undone in reverse (RFC 9110 §8.4), and whether a client does
 * that is its network stack's business, which the request says nothing about: `accept-encoding`
 * names the codings a client decodes, not how many of them it will stack. So the layer goes only
 * where the user agent names a stack known to chain a decoder per coding, and every other client is
 * sent the single layer — byte for byte what it was before there was a second, and what any client
 * that accepts `br` reads. A mistake here is only ever one way: a client left off the list loses
 * the suffix's compression, never the document.
 *
 * - Chromium, whatever it is branded as: `Chrome/`, which Edge, Opera, Samsung Internet and
 *   Android's WebView all carry. `FilterSourceStream` chains a decoder per coding.
 * - Firefox (`Firefox/`): `HttpBaseChannel` stacks a converter per coding, sixteen at most.
 * - curl, whose user agent starts with its own name, and which chains its decoders as well.
 *
 * Not Safari, which has been seen not to read `br, br`, and so not any browser on iOS or iPadOS:
 * they all load through the same WebKit stack whatever they are called, and none of them says
 * `Chrome/` or `Firefox/`. Chrome there says `CriOS/` and Firefox `FxiOS/`, and asked for the
 * desktop site they say what Safari on the Mac says, Chrome keeping its `CriOS/`. A user agent
 * that names an iPhone, iPad or iPod is refused whatever else it claims, as is legacy Edge
 * (`Edge/`, an engine of its own behind a `Chrome/` token), and anything that calls itself a
 * crawler — Googlebot among them, which is served a composed document as a browser is
 * (`classifyRequest`): a fetcher that borrows a browser's name does not borrow its network stack.
 */

/** The stacks known to chain a decoder per coding. */
const LAYERED_CLIENT_RE = /\b(?:Chrome|Firefox)\/\d|^curl\//u;
/** Refused whatever else the user agent claims: an iPhone, iPad or iPod, legacy Edge, a crawler. */
const REFUSED_CLIENT_RE = /\b(?:iPhone|iPad|iPod)\b|\bEdge\/|compatible|bot|crawl|spider/iu;

/** Whether the client that sent `userAgent` undoes `content-encoding: br, br`. */
export function decodesLayeredBrotli(userAgent: string | null): boolean {
  return (
    userAgent !== null && !REFUSED_CLIENT_RE.test(userAgent) && LAYERED_CLIENT_RE.test(userAgent)
  );
}
