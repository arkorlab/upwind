import { negotiateContentEncoding } from '@stayingupwind/core/request';
import { decodesLayeredBrotli } from '@stayingupwind/edge/handlers/layered-clients';

import { answeredBy, EDGE_HEADER } from './answers.ts';
import type { Reading } from './reading.ts';

/**
 * The coding a document comes in, held to what its request accepts (`documents.ts`): none to a
 * request that accepts none; to one that accepts a coding alone, that one; to one that accepts
 * what a browser does, one of those — as the edge sends a page it composes in, said of, and varied
 * by.
 */

/** A coding a page is asked for in, which every browser undoes. */
type Coding = 'br' | 'gzip';

/** Every coding a browser accepts a page in at once, as Chrome asks for one. */
export const BROWSER_CODINGS = 'gzip, deflate, br, zstd';
/** Every coding Safari accepts a page in at once, as it asks for one. */
const SAFARI_CODINGS = 'gzip, deflate, br';

/**
 * What a request accepts a page in (`Accept-Encoding`, as it is sent): one coding alone, or what a
 * browser accepts at once (`BROWSER_CODINGS`, `SAFARI_CODINGS`), of which the edge picks the one it
 * prefers (`negotiateContentEncoding`), answering each its own way — by the visitor's own, which
 * Cloudflare's front line keeps for it (`cf.clientAcceptEncoding`), handing it, the rules and the
 * middleware the request accepting what it sets in its place (`edgeReads`).
 */
export type Accepted = Coding | typeof BROWSER_CODINGS | typeof SAFARI_CODINGS;

/**
 * Every coding the browser naming itself `agent` accepts a page in at once: what WebKit accepts —
 * Safari's, and any browser's on iOS, each of which names `Safari/` and no `Chrome/` — or Chrome's,
 * which Firefox names alike, and an agent no browser is.
 */
export function browserCodingsOf(agent: string | undefined): Accepted {
  const webKit = agent !== undefined && agent.includes('Safari/') && !agent.includes('Chrome/');
  return webKit ? SAFARI_CODINGS : BROWSER_CODINGS;
}

/** The codings the edge composes a document in (`CONTENT_ENCODINGS` in the edge). */
const COMPOSED_CODINGS: ReadonlySet<Coding> = new Set<Coding>(['br', 'gzip']);

/** What a request accepted, in a verdict's words. */
export function acceptedInWords(accepted: Accepted): string {
  return accepted.includes(',') ? `what a browser accepts (${accepted})` : accepted;
}

/** What a document was asked for in, and by which agent (`User-Agent`), where it said one. */
export interface CodedRequest {
  readonly coding: Accepted | undefined;
  readonly agent: string | undefined;
}

/**
 * What a document was asked for in, and by which agent, as its coding is judged (`codingFailure`):
 * as it was asked — the agent its navigation names — or as a verdict carries it on.
 */
export function codedOf(asked: {
  readonly coding?: Accepted | undefined;
  readonly agent?: string | undefined;
  readonly headers?: Readonly<Record<string, string>>;
}): CodedRequest {
  return { coding: asked.coding, agent: asked.agent ?? asked.headers?.['user-agent'] };
}

/** Where the edge's account of a document says which rendering of it it sent (`enc=`). */
const RENDERING_MARKER = 'enc=';

/**
 * Why a document is not sent in what its request accepts. Asked for as it is (`accept-encoding:
 * identity`), in no coding: a coding said of bytes in none — the edge says none of such an answer
 * (`documentHeaders`) — is one a browser undoes, and fails to show the page. Asked for in a coding
 * (`Asked.coding`), in that one — in a layer of it or two, as the edge layers brotli for a browser
 * that takes two — under a `Vary` that names `Accept-Encoding`, by which a shared cache tells it
 * from its other codings, and, where the edge composed it (`composed`), saying which rendering it
 * sent (`enc=`). One the edge handed on may come in none, or in any coding the request names: the
 * Function's answer is its own (`handedOnFailure`).
 */
export function codingFailure(
  answer: Reading,
  asked: CodedRequest,
  composed = true,
): string | undefined {
  const { coding: accepted } = asked;
  const sent = answer.headers['content-encoding'];
  const layers = layersOf(sent);
  if (accepted === undefined) {
    return layers.length === 0
      ? undefined
      : `answered with Content-Encoding ${String(sent)} to a request that accepts identity alone`;
  }
  if (!composed) {
    return handedOnFailure(answer, { accepted, layers });
  }
  // The coding of those it composes in that the request takes best, as the edge negotiates it
  // (`negotiateContentEncoding`) — brotli over gzip where it takes both — in every layer.
  const coding = negotiateContentEncoding(accepted, COMPOSED_CODINGS);
  if (coding === 'identity' || layers.length === 0) {
    return unacceptedFailure(sent, accepted);
  }
  if (layers.some((layer) => layer !== coding)) {
    return `answered with Content-Encoding ${String(sent)}, not the ${coding} the edge composes a document in for a request that accepts ${accepted}`;
  }
  const varied = variedBy(answer);
  if (!varied.has('accept-encoding') && !varied.has('*')) {
    return `answered in ${coding} under no Vary naming Accept-Encoding`;
  }
  const rendering = answeredBy(answer)
    .split(';')
    .find((field) => field.startsWith(RENDERING_MARKER))
    ?.slice(RENDERING_MARKER.length);
  const sentIn = layers.length === 1 ? coding : `${layers.length} layers of ${coding}`;
  if (!renderedAs(rendering, coding, layers.length)) {
    return `answered in ${sentIn}, though the edge says it sent ${rendering ?? 'no coding'} (${EDGE_HEADER}: ${answeredBy(answer)})`;
  }
  if (layers.length === 1) {
    return undefined;
  }
  // Whole, as the edge says of a document no continuation followed (`cont=none`).
  const whole = answeredBy(answer).split(';').includes('cont=none');
  return layeredFailure(coding, { varied, agent: asked.agent, whole });
}

/** Another name a coding goes by, and the coding it names (RFC 9110 §8.4.1). */
const CODING_ALIASES: ReadonlyMap<string, string> = new Map([['x-gzip', 'gzip']]);

/**
 * The codings `Content-Encoding` says were applied, as a browser reads them (RFC 9110 §8.4.1): in
 * any case, by the name each goes by (`x-gzip` as `gzip`), and `identity` — which changes nothing —
 * left out, so that none left is no coding at all.
 */
function layersOf(sent = ''): readonly string[] {
  return sent
    .split(',')
    .map((layer) => layer.trim().toLowerCase())
    .filter((layer) => layer !== '' && layer !== 'identity')
    .map((layer) => CODING_ALIASES.get(layer) ?? layer);
}

/** What `Vary` an answer names, lower-cased. */
function variedBy(answer: Reading): ReadonlySet<string> {
  // One value, as Node.js joins a repeated `Vary`; each of several, where it would hand them apart.
  const names = [answer.headers.vary ?? []].flat().join(',');
  return new Set(names.split(',').map((name) => name.trim().toLowerCase()));
}

/** Why an answer is in none of the codings its request accepts, in a verdict's words. */
function unacceptedFailure(sent: string | undefined, accepted: Accepted): string {
  const alone = accepted.includes(',') ? '' : ' alone';
  return `answered with Content-Encoding ${sent ?? 'none'} to a request that accepts ${accepted}${alone}`;
}

/**
 * Why a document the edge handed on — the Function's answer, its own to code — is not in what its
 * request accepts: as it is, or in any coding the request names, every layer of it, under a `Vary`
 * that names `Accept-Encoding`.
 */
function handedOnFailure(
  answer: Reading,
  read: { readonly accepted: Accepted; readonly layers: readonly string[] },
): string | undefined {
  const { accepted, layers } = read;
  if (layers.length === 0) {
    return undefined;
  }
  const named = new Set(accepted.split(',').map((coding) => coding.trim()));
  const sent = layers.join(', ');
  if (layers.some((layer) => !named.has(layer))) {
    return unacceptedFailure(sent, accepted);
  }
  const varied = variedBy(answer);
  return varied.has('accept-encoding') || varied.has('*')
    ? undefined
    : `answered in ${sent} under no Vary naming Accept-Encoding`;
}

/**
 * Whether the edge's account of a document it composed (`enc=`, `encodingMarker` in the edge) names
 * the layers it came in: one of `coding` — its stored rendering as it is, or compressed as it went
 * out (`-live`) — or two, a stored brotli rendering inside a second layer (`br-br`).
 */
function renderedAs(rendering: string | undefined, coding: Coding, layers: number): boolean {
  if (layers === 2) {
    return rendering === `${coding}-${coding}`;
  }
  return layers === 1 && (rendering === coding || rendering === `${coding}-live`);
}

/**
 * Why a document sent in two layers of a coding (`Content-Encoding`) fails: the edge sends two of
 * brotli alone, a stored rendering of the shell under the layer the continuation goes in, so of a
 * document it continues and never of one whole (`layeringFor` in the edge); and only to an agent
 * it knows undoes them (`decodesLayeredBrotli`) — any other is sent one, which it reads — so the
 * answer turns on the agent as well, which a shared cache has to tell it apart by (`Vary:
 * User-Agent`).
 */
function layeredFailure(
  coding: Coding,
  asked: {
    readonly varied: ReadonlySet<string>;
    readonly agent: string | undefined;
    /** Whether the edge says no continuation followed the shell (`cont=none`). */
    readonly whole: boolean;
  },
): string | undefined {
  if (coding !== 'br' || asked.whole) {
    return `answered in two layers of ${coding}, which the edge sends of brotli alone, under a document it continues`;
  }
  if (!decodesLayeredBrotli(asked.agent ?? null)) {
    const agent = asked.agent ?? 'an agent that names none';
    return `answered in two layers of ${coding} to ${agent}, which the edge sends one`;
  }
  const { varied } = asked;
  return varied.has('user-agent') || varied.has('*')
    ? undefined
    : `answered in two layers of ${coding} under no Vary naming User-Agent`;
}
