import type { FreshnessInput } from '@stayingupwind/core/cache';

/**
 * How the stack's deploy agent (`./agent.ts`) is spoken to over its socket: a stored value by its
 * key after the store's route, a write's metadata in a header, and the two calls a deploy makes on
 * the cache authority.
 */
export const AGENT_ROUTES = {
  /** `EDGE_STATE`: a value read, or written with its metadata. */
  kv: '/kv/',
  /** `ARTIFACTS`: an object read, or written with its content type and custom metadata. */
  blob: '/blob/',
  seedScope: '/cache/seed-scope',
  seedEntries: '/cache/seed-entries',
} as const;

/**
 * A write's metadata, as JSON percent-encoded (`encodeURIComponent`): a header value holds Latin-1
 * alone, and a pathname a build records there need not be.
 */
export const METADATA_HEADER = 'x-upwind-metadata';

/**
 * The stack's backstage: a socket of the edge Worker's own — its `Backstage` entrypoint — which
 * serves no site, so no pathname of the application's is taken for what a check asks of it.
 *
 * What the edge did for one of a check's requests that the client is never told (`./edge.ts`): the
 * check registers an id of its own (`PUT /trace/<id>`) and sends the request carrying it, which the
 * edge never sees; what was kept is read once under it (`GET /trace/<id>`, a `TraceRecord`), or let
 * go of unread (`DELETE /trace/<id>`) where the check judged the request without it. Only a
 * registered id traces a request: a visitor's own header of the name reaches the site as it would
 * deployed. Kept are the middleware's answer as its protocol has it — a rewrite, the headers it set
 * — which the edge reads and running the middleware again could answer otherwise, and the record
 * the edge asked a Function to regenerate in the foreground, which its answer does not name.
 *
 * And an app Function, by the name the build gives it (`GET /function/<name>`, the pathname under
 * `path`), asked as a deployment's validation asks each through its edge: routed by the edge, told
 * the request is a probe of that Function as a signed validation tells it — so that the pointer
 * the edge serves and the Worker it dispatches by are what the answer proves — and answered as the
 * edge answers, naming the Function it asked (`fn=`) where the build was split.
 *
 * And the headers a generation of a route's record was recorded with (`GET
 * /generation/<scope>/<entry>/<seq>`, `null` for one the edge never read): what the edge sends a
 * document served from it with (`recordedHeaders` in the edge), which no answer says of itself —
 * or, asked of no sequence (`GET /generation/<scope>/<entry>`), those of every generation of the
 * record the edge read, by sequence: one of them served a part of the page, which says not which.
 *
 * And, for a site that has the edge mint a nonce for each document, what the edge makes of a nonce
 * it minted, by its own code: the bytes sent with it stamped as the edge stamps a document's
 * (`POST /stamp?nonce=<nonce>`), the digest and length of a document sent as it streams, stamped
 * so (`POST /stamped-digest?nonce=<nonce>`, a `StampedDigest`), and the policies sent (`POST
 * /nonced?nonce=<nonce>&mode=<mode>`, `&strict=1` for `'strict-dynamic'`; a `NoncedPolicies` each
 * way) with it put in them as the edge puts it under that setting — what a document's shell, the
 * rest of it, and its policies are judged by.
 */
export const TRACE_HEADER = 'x-upwind-trace';
/**
 * The `Accept-Encoding` Cloudflare's front line hands a Worker every request with, whatever the
 * visitor sent — the visitor's own kept in `cf.clientAcceptEncoding`, which the edge answers by
 * (cloudflare/workerd#5289, cloudflare/workers-sdk#5246: `gzip, br` as deployed Workers read it,
 * which the HTTP headers reference spells `br, gzip`). The stack's edge is handed every request so,
 * as a deployment's is (`./edge.ts`), and the check reads the rules and the middleware by it
 * (`edgeReads`).
 */
export const FRONT_LINE_CODINGS = 'gzip, br';
/**
 * The value of the trace header's own a traced request goes on with (`PUT /trace/<id>?as=<value>`):
 * the request carries the check's id under the name, so one that has to carry a value of the
 * application's there — one a rule asks of — has it put back as it comes in, rather than lose it.
 */
export const TRACE_KEEP_PARAM = 'as';
/** The edge Worker's entrypoint the backstage is: the class `./edge.ts` exports. */
export const BACKSTAGE_ENTRYPOINT = 'Backstage';
export const BACKSTAGE_ROUTES = {
  trace: '/trace/',
  function: '/function/',
  middleware: '/middleware',
  generation: '/generation/',
  stamp: '/stamp',
  stampedDigest: '/stamped-digest',
  nonced: '/nonced',
} as const;
/** The nonce the bytes or the policies sent are to carry, and the setting it goes in by. */
export const NONCE_PARAMS = { nonce: 'nonce', mode: 'mode', strict: 'strict' } as const;

/** A document's policies, each by its header's name: the two a nonce goes in, as far as it has them. */
export type NoncedPolicies = Readonly<Record<string, string>>;

/** A document stamped with a nonce, held nowhere whole: its SHA-256, in hex, and its length. */
export interface StampedDigest {
  readonly sha256: string;
  readonly length: number;
}

/** A middleware's answer as the edge was given it: its status, and its headers in order. */
export interface MiddlewareDecision {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
}

/**
 * The record the edge asked a Function to regenerate in the foreground: its entry, the route the
 * record is filed under, and whether the entry is a member's own beside its class shell's
 * (`runtimeCache.concreteUpgrade`), whose id no manifest names.
 */
export interface Regeneration {
  readonly entry: string;
  readonly route: string;
  readonly member: boolean;
}

/** An output a generation of a route's record holds, as its record names it: which, and its bytes. */
export interface RecordedOutput {
  /** What it is of the page: its payload (`rsc`), a segment, its props (`pages-data`), …. */
  readonly role: string;
  /** Which output of that role: `rsc`, `segment:<path>`, `pages-data`. */
  readonly representationKey: string;
  readonly encoding: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * A generation of a route's record as the edge read it (`GET /generation/<scope>/<entry>`): the
 * headers it was recorded with, and the outputs it holds — what the edge serves a part of it with.
 */
export interface RecordedGeneration {
  readonly headers: Readonly<Record<string, string>>;
  readonly artifacts: readonly RecordedOutput[];
  /** Whether a resume would finish its page: it holds the postponed state of a render. */
  readonly partial: boolean;
  /** Whether a build wrote it (`build`) — the edge serves such a one's parts as the build's — or a render since. */
  readonly source: string;
  /**
   * What the edge judges its validity by when it reads it (`evaluateFreshness`): its policy, when it
   * was rendered, and what invalidated it since — which marks a part of it `STALE` or `HIT`.
   */
  readonly freshness?: Omit<FreshnessInput, 'now'> | undefined;
}

/**
 * What the deployment's middleware made of a request it was asked about past its matchers
 * (`BACKSTAGE_ROUTES.middleware`): what it decided, as the edge reads it (`readMiddlewareResponse`),
 * under the status its answer had; or that it failed, and why.
 */
export type MiddlewareProbe =
  | { readonly kind: 'responded' | 'continue' | 'external-rewrite'; readonly status: number }
  | { readonly kind: 'failed'; readonly reason: string };

/** What the stack kept of a traced request: `null` for what did not happen. */
export interface TraceRecord {
  readonly decision: MiddlewareDecision | null;
  readonly regenerated: Regeneration | null;
}
