import type { ShellEncoding } from '@stayingupwind/core/artifact';
import type { ConfiguredHeaders, RouteEntry } from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import {
  EDGE_DEBUG_HEADER,
  EDGE_VALIDATED_HEADER,
  filterShellResponseHeaders,
  manifestIdPrefix,
  NO_STORE_CACHE_CONTROL,
} from '@stayingupwind/core/request';
import type { WireEncoding } from '@stayingupwind/host/splice';

import { serverTiming, type ServerTimingEntry } from '../observability/server-timing.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { acceptsNonce, applyNonceToHeaders } from './csp-nonce.ts';
import { applyCspReporting } from './csp-reporting-headers.ts';
import { mergeScopedMiddlewareHeaders, removeSharedCacheOverrides } from './responses.ts';

/** The headers a composed document goes out under: what it is, how it is encoded, who answered. */

const CACHE_CONTROL_HEADER = 'cache-control';
const SERVER_TIMING_HEADER = 'server-timing';
const CONTENT_ENCODING_HEADER = 'content-encoding';
const NEXT_CACHE_HEADER = 'x-nextjs-cache';
const VARY_HEADER = 'vary';
const LINK_HEADER = 'link';
export const ACCEPT_ENCODING_HEADER = 'accept-encoding';
export const USER_AGENT_HEADER = 'user-agent';
/**
 * The whole point of this response is that the shell reaches the client before the origin answers.
 * A response the runtime is left to compress is buffered by its compressor until there is enough
 * input to emit a block — which, for a PPR document, is when the continuation finally arrives. So
 * the runtime is never allowed to compress this response: the body is declared already encoded
 * (`encodeBody: 'manual'`), and what goes on the wire is one of four things. The bytes as they are,
 * when the client accepts nothing else. A shell compressed ahead of time at the highest quality
 * with the suffix framed behind it (see `@stayingupwind/host/splice`), the intended path — and, for
 * brotli when the application resumes the document and the client is one known to undo two codings
 * (`layered-clients.ts`), that same stream inside a second brotli layer that compresses the suffix
 * (`br, br`, see `live-compression.ts`). Or, when no such rendering can be used, the document
 * compressed on the way out and flushed every few kilobytes (`live-compression.ts` again), which
 * costs CPU per response but never holds a byte.
 */
export const IDENTITY_ENCODING = 'identity';
/**
 * Brotli applied twice, listed in the order applied (RFC 9110 §8.4): the rendering's stream, then
 * the layer that compresses its suffix. A client that chains its decoders undoes both, the outer
 * first; accepting `br` does not say a client does, so its user agent has to
 * (`layered-clients.ts`).
 */
const LAYERED_BROTLI_ENCODING = 'br, br';
/**
 * A document a resume completes holds what the application rendered for this one request, so
 * nothing may keep it — which is also what Next.js sends such a page with. `no-transform` tells any
 * intermediary the same thing `encodeBody: 'manual'` tells workerd.
 */
const RESUMED_DOCUMENT_CACHE_CONTROL = `${NO_STORE_CACHE_CONTROL}, no-transform`;
/**
 * A document complete without a resume is the same bytes for every visitor — the build's, or the
 * generation's — so the browser may keep it, as long as it asks again before using it: nothing here
 * is ever answered from a browser's cache unasked. What `no-cache` buys over `no-store` is the
 * back/forward cache, which Safari and Firefox refuse a `no-store` page and keep this one in.
 */
const COMPLETE_DOCUMENT_CACHE_CONTROL = 'private, no-cache, no-transform';
const NO_STORE_DIRECTIVE = 'no-store';

/** Whether a `cache-control` value has `no-store` among its directives. */
function saysNoStore(value: string): boolean {
  const directives = value.split(',').map((directive) => directive.split('=', 1)[0]?.trim());
  return directives.some((directive) => directive?.toLowerCase() === NO_STORE_DIRECTIVE);
}

/** Whether recorded headers carry a `cache-control` with `no-store` among its directives. */
function recordedNoStore(recorded: Readonly<Record<string, string>>): boolean {
  return Object.entries(recorded).some(
    ([name, value]) => name.toLowerCase() === CACHE_CONTROL_HEADER && saysNoStore(value),
  );
}

/**
 * What a composed document may be kept as: `no-store` for one a resume completes, and for one
 * whose recorded headers — the route's, or the generation's — say `no-store` themselves, as do the
 * headers a rule of `next.config` that matched the request sets (`recorded` holds both, the rules'
 * before the headers a shell does not carry, `cache-control` among them, are taken out), or whose
 * middleware's answer does as it let the request through (`middleware`: the merged response leaves
 * a middleware's `cache-control` out, so this is where it is heard); `no-cache` for any other
 * document complete without a resume. And `no-store` for every document of a project whose
 * delivery is private (`privateDelivery`): the back/forward cache `no-cache` lets a browser keep a
 * page in would bring a private page back by a history traversal once the host no longer lets its
 * visitor through, without the request the host would refuse.
 */
export function documentCacheControl(
  document: {
    readonly complete: boolean;
    readonly privateDelivery: boolean;
    readonly middleware?: Headers | undefined;
  },
  recorded: readonly Readonly<Record<string, string>>[],
): string {
  const noStore =
    document.privateDelivery ||
    saysNoStore(document.middleware?.get(CACHE_CONTROL_HEADER) ?? '') ||
    recorded.some((headers) => recordedNoStore(headers));
  return !noStore && document.complete
    ? COMPLETE_DOCUMENT_CACHE_CONTROL
    : RESUMED_DOCUMENT_CACHE_CONTROL;
}

/**
 * The response now differs by `header`; say so without repeating what the origin said.
 *
 * `*` is an alternative to a field-name list, not a member of one, so a response that already says it
 * is left alone: adding to it would make a value a shared cache may misparse — and one that already
 * says everything varies has nothing to add.
 */
export function varyOn(headers: Headers, header: string): void {
  const existing = headers.get(VARY_HEADER);
  if (existing === null) {
    headers.set(VARY_HEADER, header);
    return;
  }
  // Compared without case, which is how a field name is read. Every caller here names one in lower
  // case, so this changes nothing any of them does — it keeps the next one from saying a name twice
  // by spelling it the way a header usually is.
  const names = new Set(existing.split(',').map((name) => name.trim().toLowerCase()));
  if (!names.has(header.trim().toLowerCase()) && !names.has('*')) {
    headers.set(VARY_HEADER, `${existing}, ${header}`);
  }
}

/**
 * Name the shell's own render-blocking resources on `Link`, beside whatever the origin named.
 *
 * The values were read from the shell when the route was proved, and deduplicated against the
 * origin's `Link` there, so this is a join and a concatenation — the serving path never looks
 * inside a shell. A browser can start the stylesheet with the headers rather than after parsing
 * its way to it, and Cloudflare's Early Hints cache, when the zone has it on, replays them as a
 * `103` before this Worker runs at all.
 *
 * Not for a project that mints CSP nonces. Its policy is the one likely to name a nonce under
 * `style-src`, and a header-borne preload has no nonce to carry — it cannot be minted at proof
 * time and a `103` is sent before there is a response to mint one for. The opt-in is the whole
 * criterion, exactly as it is for using a pre-compressed rendering.
 *
 * Nor for a URI that answers with more than one thing: one the application's middleware matched,
 * whatever it did with this request. Nor for shadow validation, which answers on a live pathname
 * with a candidate nobody has promoted.
 */
function applyPreloads(headers: Headers, header: DocumentHeaderInput): void {
  const { entry, edge } = header;
  if (entry.preloads === undefined || edge.cspNonce) {
    return;
  }
  // Not for a URI that answers with more than one thing. A URI a middleware matched can answer
  // differently for the next visitor — it let this request through, and nothing here can say what
  // it would do with a cookie this one did not carry. Cloudflare's Early Hints cache is keyed by
  // the URI alone, so one visitor's `103` is replayed to the next, naming a stylesheet they were
  // never sent to.
  if (header.middleware !== undefined) {
    return;
  }
  // Nor for a validation request. It asks for the candidate on the pathname live visitors use, and
  // the `103` cache would keep what a deployment nobody has promoted — or one about to be turned
  // down — named on it. Validation leaves nothing in a shared cache; this is one of those.
  if (edge.validated) {
    return;
  }
  const added = entry.preloads.join(', ');
  const advertised = headers.get(LINK_HEADER);
  headers.set(
    LINK_HEADER,
    advertised === null || advertised === '' ? added : `${advertised}, ${added}`,
  );
}

/** Where the shell came from and how the document goes out. */
export interface ShellDelivery {
  readonly source: string;
  readonly lookupMs: number;
  /** The `content-encoding` the client negotiated — applied twice when `outbound` is `layered`. */
  readonly encoding: ShellEncoding | typeof IDENTITY_ENCODING;
  /** What the splice puts on the wire: a pre-compressed head, or the bytes as they are. */
  readonly wire: WireEncoding;
  /**
   * What happens to the wire on the way out. `none`: it goes as it is — identity, or a rendering's
   * single layer. `live`: the wire is identity but the encoding is not, so the document is
   * compressed on the way out. `layered`: a brotli rendering's wire goes inside a second brotli
   * layer that compresses the suffix; only ever for a document the application resumes.
   */
  readonly outbound: 'none' | 'live' | 'layered';
  /**
   * The client's user agent chose between `layered` and `none` (`layered-clients.ts`), so the
   * response varies by it as it does by `accept-encoding`.
   */
  readonly variesByAgent: boolean;
}

/**
 * What reading the route's delivery record cost: a served record's own lookup, with where it came
 * from (`memory`, `cache-api`, `kv`), or the lookup that found none to serve, with why (`no-record`,
 * `corrupt`, `unsupported`, `record-unavailable`), the build's shell answering in its place.
 */
export interface RecordTiming {
  readonly lookupMs: number;
  readonly description: string;
}

/** `enc=` on `x-arkor-edge`, and the metric's encoding: which of the four paths answered. */
export function encodingMarker(shell: ShellDelivery): string {
  switch (shell.outbound) {
    case 'live': {
      return `${shell.encoding}-live`;
    }
    case 'layered': {
      return `${shell.encoding}-${shell.encoding}`;
    }
    case 'none': {
      return shell.encoding;
    }
  }
}

/** The `content-encoding` the body goes out under. */
function contentEncodingOf(shell: ShellDelivery): string {
  return shell.outbound === 'layered' ? LAYERED_BROTLI_ENCODING : shell.encoding;
}

export interface DocumentHeaderInput {
  readonly entry: RouteEntry;
  /** The shell and configured headers already prepared before starting its continuation. */
  readonly headers: Headers;
  readonly edge: EdgeContext;
  /** The shell strategy that answered, named on `x-arkor-edge` beside where the bytes came from. */
  readonly strategyId: string;
  readonly shell: ShellDelivery;
  /**
   * Mints the nonce, for a project that handed CSP nonces to the edge; `undefined` for one that
   * did not. Called only once the final policy is known — see `documentHeaders`.
   */
  readonly mintNonce: (() => string) | undefined;
  /** What `x-arkor-edge` says about the document beyond the shell that answered it. */
  readonly hosted: string;
  /** What the application's middleware set, when the edge ran it and it let the request on. */
  readonly middleware: Extract<MiddlewareResult, { kind: 'continue' }> | undefined;
  /**
   * Where a hosted application's document complete without a resume came from, as Next.js says it
   * (`x-nextjs-cache`): `HIT` from the cache, `STALE` from it while it is regenerated. Its own
   * server says nothing of a page a resume completes, and neither is anything said here then.
   */
  readonly nextCache: 'HIT' | 'STALE' | undefined;
  /** What the document may be kept as (`documentCacheControl`). */
  readonly cacheControl: string;
  /** The delivery record read for the route, if one was. */
  readonly record: RecordTiming | undefined;
}

/** The response's headers, and the nonce (if any) the body must be stamped with to match them. */
export interface DocumentHeaders {
  readonly headers: Headers;
  readonly nonce: string | undefined;
}

/**
 * The application's headers before middleware, from those recorded with what is served — the
 * route's, or the generation's the runtime cache answered with; reused after checking its final
 * recovery policy.
 */
export function replayedDocumentHeaders(
  recorded: Readonly<Record<string, string>>,
  rules: ConfiguredHeaders,
): Headers {
  const headers = new Headers(filterShellResponseHeaders(Object.entries(recorded)));
  // The rules judged now, in their own order, over what was folded in at deployment: the later
  // of two rules naming one header wins, as in the application's own router.
  const configured = filterShellResponseHeaders(Object.entries(rules.headers));
  for (const [name, value] of Object.entries(configured)) {
    headers.set(name, value);
  }
  return headers;
}

/**
 * A middleware that times its own work says so in `Server-Timing` as well, and the merge set its
 * list in place of the edge's. Both stand, in one header: what the application measured, then what
 * the request waited on at the edge. One the middleware set empty is no list of its own, and the
 * edge's goes out alone.
 */
function joinServerTiming(headers: Headers, middlewareHeaders: Headers, timing: string): void {
  const own = middlewareHeaders.get(SERVER_TIMING_HEADER)?.trim();
  if (own !== undefined) {
    headers.set(SERVER_TIMING_HEADER, own === '' ? timing : `${own}, ${timing}`);
  }
}

/**
 * `Server-Timing`: what the document waited on, in the order it came to — the pointer, the
 * manifest, the middleware, the record — and where the shell came from. A wait the request did not
 * make is left out. These are the times the lookups took as they finished; nothing waits for them.
 */
function timingEntries(header: DocumentHeaderInput): ServerTimingEntry[] {
  const { timings } = header.edge;
  const entries: ServerTimingEntry[] = [];
  if (timings.pointerMs !== undefined) {
    entries.push({ name: 'ptr', durationMs: timings.pointerMs });
  }
  if (timings.manifestMs !== undefined) {
    entries.push({ name: 'man', durationMs: timings.manifestMs });
  }
  if (timings.middlewareMs !== undefined) {
    entries.push({ name: 'mw', durationMs: timings.middlewareMs });
  }
  if (header.record !== undefined) {
    const { lookupMs, description } = header.record;
    entries.push({ name: 'rec', durationMs: lookupMs, description });
  }
  entries.push({
    name: 'shell',
    durationMs: header.shell.lookupMs,
    description: header.shell.source,
  });
  return entries;
}

export function documentHeaders(header: DocumentHeaderInput): DocumentHeaders {
  const { entry, edge, shell, headers } = header;
  headers.set('content-type', entry.shell.contentType);
  if (header.nextCache !== undefined) {
    headers.set(NEXT_CACHE_HEADER, header.nextCache);
  }
  headers.set(CACHE_CONTROL_HEADER, header.cacheControl);
  // `identity` names no coding only where a client says what it accepts (RFC 9110 §12.5.3). On a
  // response, no coding is said by sending no `content-encoding` at all.
  const coding = contentEncodingOf(shell);
  if (coding === IDENTITY_ENCODING) {
    headers.delete(CONTENT_ENCODING_HEADER);
  } else {
    headers.set(CONTENT_ENCODING_HEADER, coding);
  }
  const timing = serverTiming(timingEntries(header));
  headers.set(SERVER_TIMING_HEADER, timing);
  const manifestPrefix = manifestIdPrefix(edge.manifestId);
  // `policy` lets validation assert that it exercised the candidate it asked for.
  const encoded = shell.encoding === IDENTITY_ENCODING ? '' : `;enc=${encodingMarker(shell)}`;
  if (edge.validated) {
    headers.set(EDGE_VALIDATED_HEADER, '1');
  }
  // Last, so nothing above can drop them: what the middleware set is part of what the application
  // answers with, whether the edge or its Worker composes the document.
  if (header.middleware !== undefined) {
    mergeScopedMiddlewareHeaders(headers, header.middleware.responseHeaders, edge.forwarding);
    joinServerTiming(headers, header.middleware.responseHeaders, timing);
  }
  // Every composed document is one visitor's — `documentCacheControl` says `private` whatever else
  // it says — so the lifetimes a rule or the middleware gave shared caches go: `CDN-Cache-Control`
  // and its kin outrank `cache-control` for exactly those caches, and one honouring them would hand
  // this visitor's document, cookie and all, to the next.
  removeSharedCacheOverrides(headers);
  // After them, and added to theirs: a `Vary` the middleware set says what the application's answer
  // turns on, and cannot say what the edge's does — the coding, and whether it goes in two layers,
  // were chosen here from the client's own headers.
  varyOn(headers, ACCEPT_ENCODING_HEADER);
  if (shell.variesByAgent) {
    varyOn(headers, USER_AGENT_HEADER);
  }
  // Only now: the policy this response carries is the one the build recorded, narrowed by the
  // rules `next.config` matched on this request and by whatever the middleware set. Deciding from
  // the build's copy alone would mint no nonce for a rule that adds a placeholder, and would stamp
  // the body with one the replacing policy does not allow.
  const nonce =
    header.mintNonce !== undefined && acceptsNonce(headers) ? header.mintNonce() : undefined;
  if (nonce !== undefined) {
    applyNonceToHeaders(headers, nonce, edge.cspNonceMode, edge.cspStrictDynamic);
  }
  const cspMarker = nonce === undefined ? '' : ';csp=nonce';
  const cspModeMarker =
    edge.cspNonce && edge.cspNonceMode === 'report-only' ? ';csp-mode=report-only' : '';
  // The setting, as the mode's marker is: what shadow validation checks the run's against.
  const strictDynamicMarker = edge.cspNonce && edge.cspStrictDynamic ? ';csp-strict-dynamic' : '';
  headers.set(
    EDGE_DEBUG_HEADER,
    `shell;strategy=${header.strategyId};src=${shell.source};m=${manifestPrefix};policy=${edge.policy.id}${cspMarker}${cspModeMarker}${strictDynamicMarker}${encoded}${header.hosted}`,
  );
  applyPreloads(headers, header);
  applyCspReporting(headers, edge.cspReportingPath);
  return { headers, nonce };
}
