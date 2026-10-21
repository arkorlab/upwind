import type { ShellEncoding } from '@stayingupwind/core/artifact';
import {
  type ConfiguredHeaders,
  foldedHeadersFor,
  headerRulesFor,
  staticFileKey,
} from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import {
  dataRequestHeaders,
  negotiateContentEncoding,
  NEXT_ROUTER_PREFETCH_HEADER,
  NO_STORE_CACHE_CONTROL,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  RSC_HEADER,
} from '@stayingupwind/core/request';

import {
  answeredBy,
  answerTo,
  type CheckedStack,
  EDGE_HEADER,
  failed,
  FROM_STORAGE,
  HTTP_OK,
  keptFailure,
  keptOf,
  withGenerationEvidence,
  middlewareAnswered,
  middlewareHeadersOnly,
  middlewareCovers,
  policyFailure,
  skipped,
  traced,
  undoneUnlessStored,
  unrunFailure,
  type Verdict,
  edgeReads,
} from './answers.ts';
import { sharedCacheFailure } from './cache-control.ts';
import { type Accepted, acceptedInWords, BROWSER_CODINGS } from './codings.ts';
import { rewrittenOnto } from './files.ts';
import {
  claimedAsLeft,
  headersLeftAlone,
  landingOf,
  moveOf,
  rewriteOf,
  whereLanded,
} from './landings.ts';
import { pagesHandoffVerdict, pagesHeadersOnly } from './pages-handoffs.ts';
import { APPLICATIONS, bypassedFor, generationsServed, handedOnVerdict } from './part-handoffs.ts';
import {
  CACHE_CONTROL,
  CONTENT_ENCODING,
  recordedAppliedFailure,
  SET_COOKIE,
  valueOf,
  variesBy,
  type Within,
} from './part-headers.ts';
import {
  CACHE_HEADER,
  markedFailure,
  type Part,
  type PartKind,
  PRERENDER_HEADER,
  STALE,
} from './part-marks.ts';
import { partTypeFailure } from './part-types.ts';
import type { Reading } from './reading.ts';
import { routedReads } from './routing-reads.ts';

/**
 * A part of a route, asked for as the client router asks for it (`parts.ts`), judged as the edge
 * answers it (`segment.ts` in the edge): from what the build wrote, or from a generation the runtime
 * rendered since — its bytes, its type, how Next.js marks it, what the application set on it, how
 * caches may hold it, and the codings it is sent in — behind the middleware where the build's
 * matchers cover it.
 */

/** What a request accepts a part in. */
export const ACCEPT_ENCODING = 'accept-encoding';
/** What the edge varies an RSC payload by: what the router asked, what it accepts. */
const ROUTER_VARY: readonly string[] = [
  RSC_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  ACCEPT_ENCODING,
];
/**
 * The headers by which the edge tells which part of a page a router's request asks for
 * (`composeSegment`, `composePayload`, `answerPart`): React Server Components at all, a segment by
 * its path, a prefetch by its kind.
 */
const PART_NAMING: readonly string[] = [
  RSC_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
];
/** Why a part the middleware asked for another part in the place of is judged no further. */
const RENAMED =
  "the application's: its middleware changed which part of the page the request asks for";

/**
 * Whether the middleware changed which part of a page the request asks for, as the edge reads the
 * headers it left (`PART_NAMING`) — which the part asked for is then no measure of. None of a page's
 * props, which their URL names alone.
 */
function renamedPart(part: Part, asked: Readonly<Record<string, string>>, left: Headers): boolean {
  if (part.kind === 'data') {
    return false;
  }
  const sent = edgeReads(asked);
  return PART_NAMING.some((name) => sent.get(name) !== left.get(name));
}

/** What a part's answer differs by, as the edge varies it. */
const PART_VARY: Readonly<Record<PartKind, readonly string[]>> = {
  segment: ROUTER_VARY,
  payload: ROUTER_VARY,
  data: [ACCEPT_ENCODING],
};

/**
 * What a client asks a part in: each coding the edge sends a part in where it holds one, alone —
 * and what the browser the router runs in accepts at once (`Part.browserCodings`), which the edge
 * answers each its own way (`Accepted`).
 */
const PART_CODINGS: readonly Accepted[] = ['br', 'gzip'];

/**
 * The rules of `next.config` as the edge judges them for a part (`configuredHeadersForPart`): on the
 * request as it reached the edge — a request for a page's props with the `x-nextjs-data` Next.js's
 * routing puts on every one (`dataRequestHeaders`) — and, for a part of a page of a build whose
 * routing the edge does not reproduce, or whose manifest says neither, with the `Link` the
 * application set on the page.
 */
function configuredFor(
  stack: CheckedStack,
  part: Part,
  sent: Readonly<Record<string, string>>,
): ConfiguredHeaders {
  const { manifest } = stack;
  const asked = routedReads(part.url, sent);
  const configured = headerRulesFor(
    manifest,
    part.url,
    part.kind === 'data' ? dataRequestHeaders(asked) : asked,
  );
  const published =
    manifest.foldedHeaderRules === undefined && manifest.dynamicRoutes !== undefined;
  if (published || part.kind === 'data' || Object.hasOwn(configured.headers, 'link')) {
    return configured;
  }
  const link =
    manifest.foldedHeaderRules === undefined
      ? Object.entries(part.route.headers).find(([name]) => name.toLowerCase() === 'link')?.[1]
      : foldedHeadersFor(manifest, part.route.pathname)?.['link'];
  return link === undefined
    ? configured
    : { ...configured, headers: { ...configured.headers, link } };
}

/** What the application set `name` to, if anything: its middleware's value over its rules'. */
function setByApplication(
  name: string,
  configured: ConfiguredHeaders,
  decided: MiddlewareResult | undefined,
): string | undefined {
  const middleware = decided?.kind === 'continue' ? decided.responseHeaders.get(name) : null;
  return middleware ?? configured.headers[name];
}

/** Where a part's answer says it came from: what the build wrote, a runtime generation, or either. */
type Provenance = 'build' | 'runtime' | 'either';

/**
 * Where a part came from, as only its answer says (`generationHeaders`, `cacheControlFor` in the
 * edge): a generation the runtime rendered since the build's, whose bytes are not the build's, where
 * it is a payload or props marked stale, which the edge marks one of the build never, whatever was
 * set; or marked rendered since (`x-nextjs-prerender`, a segment's or a payload's) or kept from every
 * cache (`private, no-store`) as the edge marks every part of a runtime generation over whatever the
 * application set — either, where the application set those very marks itself, which a part of the
 * build goes out with as well. A page's props it marks no other way, as Next.js's own server marks
 * them none.
 */
function provenanceOf(
  kind: PartKind,
  answer: Reading,
  judged: {
    readonly configured: ConfiguredHeaders;
    readonly decided: MiddlewareResult | undefined;
  },
): Provenance {
  const { configured, decided } = judged;
  // Stale as the edge marks a payload or props over whatever was set: a segment it marks no such
  // way, so a segment's mark is the application's own (`generationHeaders`).
  if (kind !== 'segment' && answer.headers[CACHE_HEADER] === STALE) {
    return 'runtime';
  }
  const prerendered = kind !== 'data' && answer.headers[PRERENDER_HEADER] === '1';
  const kept = valueOf(answer, CACHE_CONTROL) === NO_STORE_CACHE_CONTROL;
  if (!prerendered && !kept) {
    return 'build';
  }
  const own =
    (prerendered && setByApplication(PRERENDER_HEADER, configured, decided) === undefined) ||
    (kept && setByApplication(CACHE_CONTROL, configured, decided) !== NO_STORE_CACHE_CONTROL);
  return own ? 'runtime' : 'either';
}

/**
 * Whether a part is one visitor's answer: one from a runtime generation, or that a rule with
 * conditions laid headers on, a cookie came with, or the middleware ran for — which the edge keeps
 * from shared caches (`cacheControlFor`), its shared caches' own headers taken off.
 */
function oneVisitors(answer: Reading, configured: ConfiguredHeaders, runtime: boolean): boolean {
  return (
    runtime ||
    configured.conditioned ||
    answer.headers[SET_COOKIE] !== undefined ||
    answeredBy(answer).split(';').includes('mw=hit')
  );
}

/** Where the edge's account of a part says which rendering of it it sent (`enc=`). */
function renderingOf(answer: Reading): string | undefined {
  return answeredBy(answer)
    .split(';')
    .find((field) => field.startsWith('enc='))
    ?.slice('enc='.length);
}

/** The codings the edge holds a rendering of a part of the build in beside its bytes. */
const HELD_CODINGS: readonly ShellEncoding[] = ['br', 'gzip'];

/**
 * The codings the edge holds a rendering of a part in beside its bytes, as its route names them
 * (`RouteSegment.encodings`): a segment's of its path, the page's payload's, its props' — and none of
 * a runtime generation's, which it holds as they are (`answerPart` in the edge).
 */
function heldCodings(part: Part, runtime: boolean): ReadonlySet<ShellEncoding> {
  if (runtime) {
    return new Set();
  }
  const { route } = part;
  const path = part.headers[NEXT_ROUTER_SEGMENT_PREFETCH_HEADER] ?? '';
  const segment =
    route.segments !== undefined && Object.hasOwn(route.segments, path)
      ? route.segments[path]
      : undefined;
  const held = { segment, payload: route.payload, data: route.pagesData }[part.kind];
  return new Set(HELD_CODINGS.filter((coding) => held?.encodings?.[coding] !== undefined));
}

/**
 * Why a part is not sent in what its request accepts: in no coding to one that accepts none; to one
 * that accepts a coding, in the one of those the edge holds a rendering of the part in that the
 * request takes best, or as it is where it holds none of them (`chosenRendering` in the edge) — as
 * its own account says (`enc=`).
 */
function partCodingFailure(
  answer: Reading,
  coding: Accepted | undefined,
  held: ReadonlySet<ShellEncoding>,
): string | undefined {
  const sent = valueOf(answer, CONTENT_ENCODING);
  if (coding === undefined) {
    return sent === undefined
      ? undefined
      : `answered with Content-Encoding ${sent} to a request that accepts identity alone`;
  }
  const expected = negotiateContentEncoding(coding, held);
  const said = sent ?? 'identity';
  if (said !== expected) {
    return `answered with Content-Encoding ${sent ?? 'none'}, not the ${expected} the edge holds the part in for the request`;
  }
  const rendering = renderingOf(answer);
  return said === rendering
    ? undefined
    : `answered with Content-Encoding ${sent ?? 'none'}, though the edge says it sent ${rendering ?? 'nothing'} (${EDGE_HEADER}: ${answeredBy(answer)})`;
}

/**
 * Whether the middleware moved a part off its route by the headers alone: it changed the headers
 * the edge routes the part by, which then lands — as the edge routes a part the middleware left so
 * (`hostedEntry`) — on another route, or on none it answers from storage (`landingOf`).
 */
function movedByHeaders(
  stack: CheckedStack,
  part: Part,
  read: {
    readonly decided: Extract<MiddlewareResult, { kind: 'continue' }>;
    /** The headers the part was asked with, as the middleware was handed them. */
    readonly asked: Readonly<Record<string, string>>;
  },
): boolean {
  const { decided } = read;
  return (
    !headersLeftAlone(read.asked, decided.requestHeaders) &&
    landingOf(stack, decided.url, decided)?.pathname !== part.route.pathname
  );
}

/**
 * A part the middleware moved — rewrote, or changed the headers it is routed by — judged where the
 * edge routes it as the middleware left it (`hostedEntry`): onto a file of the build, as that file
 * (`rewrittenOnto`); onto another route, as that route's part — the build's, or a runtime
 * generation's — unless its `bypassFor` holds, which leaves it to Next.js; onto none the edge
 * serves, as no part at all. None where it lands on the route asked for, which judges it as asked.
 */
async function movedPartVerdict(
  stack: CheckedStack,
  part: Part,
  read: {
    readonly answer: Reading;
    readonly decided: Extract<MiddlewareResult, { kind: 'continue' }>;
    readonly coding: Accepted | undefined;
    readonly asked: Readonly<Record<string, string>>;
    readonly within?: Within | undefined;
  },
): Promise<Verdict | undefined> {
  const { answer, decided } = read;
  const landed = landingOf(stack, decided.url, decided);
  if (landed?.pathname === part.route.pathname) {
    return undefined;
  }
  const answered = answeredBy(answer);
  const onto = rewriteOf(decided);
  if (answered.startsWith(FROM_STORAGE)) {
    const file = onto === undefined ? undefined : staticFileKey(stack.manifest, onto.pathname);
    return file === undefined
      ? failed(`answered as a file, though the middleware moved it onto none of the build's`)
      : rewrittenOnto(stack, file, {
          url: part.url,
          headers: read.asked,
          answer,
          middleware: decided,
        });
  }
  const where = `${moveOf(decided).done} ${whereLanded(landed)}`;
  if (landed === undefined || !answered.startsWith(`${part.kind};`)) {
    return failed(`${where}, and answered by the edge as it is (${EDGE_HEADER}: ${answered})`);
  }
  const moved = { ...part, route: landed, built: part.builtOn(landed) };
  if (bypassedFor(stack, moved, read)) {
    return failed(
      `${where}, whose bypassFor holds for the request, and answered from storage (${EDGE_HEADER}: ${answered})`,
    );
  }
  const failure = await answerFailure(stack, moved, read);
  return failure === undefined
    ? skipped(`the application's middleware moved it onto the route ${landed.pathname}`)
    : failed(`${where}, and ${failure}`);
}

/**
 * A part answered from storage, as the middleware left it: a failure where what the stack kept of
 * the middleware disagrees with what the edge says of it, or the edge ran none that covers it
 * (`keptFailure`, `unrunFailure`); the application's where the middleware changed which part the
 * request asks for (`renamedPart`). None where it is to be judged as asked, or as moved.
 */
function leftVerdict(
  part: Part,
  read: {
    readonly answer: Reading;
    readonly decided: MiddlewareResult | undefined;
    readonly covered: boolean;
    readonly asked: Readonly<Record<string, string>>;
  },
): Verdict | undefined {
  const { decided } = read;
  const unkept =
    keptFailure(read.answer, decided) ??
    unrunFailure(decided, read.covered, 'answered it from storage');
  if (unkept !== undefined) {
    return failed(unkept);
  }
  return decided?.kind === 'continue' && renamedPart(part, read.asked, decided.requestHeaders)
    ? skipped(RENAMED)
    : undefined;
}

/**
 * A part asked for — as it is, or in a coding a client accepts (`coding`), read undone of it — and
 * judged: behind the middleware where the build's matchers cover it, as it ran (`keptOf`), and then
 * as the edge answers it (`answerFailure`) — where the middleware moved it, where it landed
 * (`movedPartVerdict`). One the middleware answered itself, or the edge handed on to the Function,
 * is the application's (`skipped`).
 */
async function askedVerdict(
  stack: CheckedStack,
  part: Part,
  coding: Accepted | undefined,
): Promise<Verdict> {
  const asked =
    coding === undefined ? part.headers : { ...part.headers, [ACCEPT_ENCODING]: coding };
  await using tracing = await traced(stack, asked);
  const { headers, trace } = tracing;
  // Read undone of its coding — but a file of the build the middleware may move it onto, as stored
  // (`rewrittenOnto`).
  const from = Date.now();
  const answer = await answerTo(part.url, {
    via: stack.url,
    headers,
    decode: undoneUnlessStored(coding !== undefined),
    headersOnly: pagesHeadersOnly(stack, part.url, asked, middlewareHeadersOnly),
  });
  if (typeof answer === 'string') {
    return failed(answer);
  }
  const within = { from, to: Date.now() };
  // What a browser keeps of the answer to its own request — in what it accepts at once — whatever
  // the verdict, which it asks for the page's other parts with (`flowFailure`).
  if (coding === (part.browserCodings ?? BROWSER_CODINGS)) {
    part.answered?.(answer);
  }
  if (middlewareAnswered(answer) !== undefined) {
    return skipped(APPLICATIONS);
  }
  const pages = pagesHandoffVerdict(stack, part.url, asked, answer);
  if (pages !== undefined) return pages;
  // What the middleware decided, which the edge answers a part it covers behind.
  const kept = await keptOf(stack, trace, part.url, asked);
  const { decided } = kept;
  const captured = withGenerationEvidence(stack, kept);
  const covered = middlewareCovers(stack, part.url, asked);
  return await partAnswerVerdict(captured, part, {
    answer,
    decided,
    covered,
    coding,
    asked,
    within,
  });
}

/** Judge an already read part against the build or the generation that actually answered it. */
export async function partAnswerVerdict(
  stack: CheckedStack,
  part: Part,
  read: {
    readonly answer: Reading;
    readonly decided: MiddlewareResult | undefined;
    readonly covered: boolean;
    readonly coding: Accepted | undefined;
    readonly asked: Readonly<Record<string, string>>;
    readonly within: Within;
  },
): Promise<Verdict> {
  const { answer, decided, covered, coding, asked, within } = read;
  const pages = pagesHandoffVerdict(stack, part.url, asked, answer);
  if (pages !== undefined) return pages;
  const answered = answeredBy(answer);
  if (answered.startsWith('passthrough;')) {
    return handedOnVerdict(stack, part, { answered, decided, covered, asked });
  }
  const left = leftVerdict(part, { answer, decided, covered, asked });
  if (left !== undefined) {
    return left;
  }
  if (
    decided?.kind === 'continue' &&
    (decided.rewritten || movedByHeaders(stack, part, { decided, asked }))
  ) {
    const moved = await movedPartVerdict(stack, part, { answer, decided, coding, asked, within });
    if (moved !== undefined) {
      return moved;
    }
  }
  // Anything else but the part itself — a file of the build, a document — the edge answered past
  // whatever the middleware decided.
  if (!answered.startsWith(`${part.kind};`)) {
    return failed(`not answered by the edge as the part it is (${EDGE_HEADER}: ${answered})`);
  }
  // A rule that claims the request as the middleware left it — or as it was sent, in the coding it
  // accepts — leaves the edge no route to answer it from (`hostedEntry`).
  const sent = { route: part.route, url: part.url, headers: asked, exact: part.exact };
  if (claimedAsLeft(stack, sent, decided)) {
    return failed(
      `answered from storage, though a rule of next.config claims the request (${EDGE_HEADER}: ${answered})`,
    );
  }
  if (bypassedFor(stack, part, { decided, asked })) {
    return failed(
      `answered from storage, though its route's bypassFor holds for the request, which Next.js renders itself (${EDGE_HEADER}: ${answered})`,
    );
  }
  return failed(await answerFailure(stack, part, { answer, decided, coding, asked, within }));
}

/** What the edge says of a page's props asked for their headers alone, which it hands the Function. */
const PROPS_HEAD = /^passthrough;reason=pages-data(?:;|$)/u;

/**
 * A page's props asked for their headers alone (`HEAD`), as the Pages Router asks for them again
 * once a navigation fetched them, signalling a revalidation (`fetchNextData`'s background request),
 * judged: the Function's, which the edge hands every such request to (`composePagesData`) — the
 * application's where its middleware answered it, or the edge handed it on before for a reason it
 * gives a request for props (`handedOnVerdict`); a failure where the edge answered it itself. With
 * the answer, which a browser keeps the cookies of.
 */
export async function propsHeadVerdict(
  stack: CheckedStack,
  part: Part,
): Promise<{ readonly verdict: Verdict; readonly answer?: Reading }> {
  await using tracing = await traced(stack, part.headers);
  const { headers, trace } = tracing;
  const answer = await answerTo(part.url, { via: stack.url, headers, method: 'HEAD' });
  if (typeof answer === 'string') {
    return { verdict: failed(answer) };
  }
  const pages = pagesHandoffVerdict(stack, part.url, part.headers, answer, 'HEAD');
  if (pages !== undefined) return { verdict: pages, answer };
  const answered = answeredBy(answer);
  if (middlewareAnswered(answer) !== undefined || PROPS_HEAD.test(answered)) {
    return { verdict: skipped(APPLICATIONS), answer };
  }
  if (!answered.startsWith('passthrough;')) {
    const said = `answered by the edge itself (${EDGE_HEADER}: ${answered}), though it hands the Function a request for a page's props' headers alone`;
    return { verdict: failed(said), answer };
  }
  const kept = await keptOf(stack, trace, part.url, part.headers);
  const { decided } = kept;
  const captured = withGenerationEvidence(stack, kept);
  const covered = middlewareCovers(stack, part.url, part.headers);
  const asked = part.headers;
  return {
    verdict: handedOnVerdict(captured, part, { answered, decided, covered, asked }),
    answer,
  };
}

/**
 * Why a part of a route is not answered as the edge answers it, from what the build wrote or from a
 * generation the runtime rendered since (`askedVerdict`) — asked for as it is, and then in each
 * coding a client accepts, which the edge answers each its own way: one the application takes is no
 * reason to ask no further. The first failure, in a verdict's words.
 */
export async function partFailure(stack: CheckedStack, part: Part): Promise<string | undefined> {
  // Each asked apart: the edge answers each in a coding of its own.
  const identity = await askedVerdict(stack, part, undefined);
  if (identity.kind === 'failed') {
    return identity.reason;
  }
  for (const coding of [...PART_CODINGS, part.browserCodings ?? BROWSER_CODINGS]) {
    const coded = await askedVerdict(stack, part, coding);
    if (coded.kind === 'failed') {
      return `asked for in ${acceptedInWords(coding)}, ${coded.reason}`;
    }
  }
  return undefined;
}

/**
 * Why a part the edge answered itself, behind the middleware as it ran, is not what it is to be —
 * from what the build wrote, or from a generation the runtime rendered since (`provenanceOf`):
 * `200`, in what the request accepts (`partCodingFailure`), of its type (`typeFailure`), the
 * build's bytes once undone but for a runtime's — a runtime's alone where the build wrote none —
 * under a `Vary` that names what tells two parts apart, marked as Next.js marks the part (`markedFailure`), carrying what the application set on
 * it (`appliedFailure`), kept from shared caches where it is one visitor's, and under the stack's
 * policy.
 */
async function answerFailure(
  stack: CheckedStack,
  part: Part,
  read: {
    readonly answer: Reading;
    readonly decided: MiddlewareResult | undefined;
    readonly coding: Accepted | undefined;
    /** The headers the part was asked with, which the rules are judged on. */
    readonly asked: Readonly<Record<string, string>>;
    /** When it was asked for and answered (`cacheStateFailure`). */
    readonly within?: Within | undefined;
  },
): Promise<string | undefined> {
  const { answer, decided } = read;
  if (answer.status !== HTTP_OK) {
    return `answered ${answer.status}`;
  }
  const configured = configuredFor(stack, part, read.asked);
  // Of a runtime generation only where the edge may answer from one at all; and, marked only as the
  // application marks it too, either's: as the build's, and failing that, as a runtime generation's
  // — whose failure stands where its bytes are not the build's.
  const provenance = generationsServed(stack, part.route)
    ? provenanceOf(part.kind, answer, { configured, decided })
    : 'build';
  if (provenance !== 'either') {
    return judgedFailure(stack, part, { ...read, configured, runtime: provenance === 'runtime' });
  }
  const asBuilt = await judgedFailure(stack, part, { ...read, configured, runtime: false });
  if (asBuilt === undefined) {
    return undefined;
  }
  const asRendered = await judgedFailure(stack, part, { ...read, configured, runtime: true });
  if (asRendered === undefined) {
    return undefined;
  }
  const { built } = part;
  const builds = answer.sha256 === built?.sha256 && answer.length === built.byteLength;
  return builds ? asBuilt : asRendered;
}

/**
 * Why a part is not what it is to be, judged as from what the build wrote, or from a generation the
 * runtime rendered since (`runtime`): in what the request accepts (`partCodingFailure`), of its
 * type, the build's bytes but for a runtime's — a runtime's alone where the build wrote none — and
 * the rest as `answerFailure` holds a part to.
 */
async function judgedFailure(
  stack: CheckedStack,
  part: Part,
  read: {
    readonly answer: Reading;
    readonly decided: MiddlewareResult | undefined;
    readonly coding: Accepted | undefined;
    readonly configured: ConfiguredHeaders;
    readonly runtime: boolean;
    readonly within?: Within | undefined;
  },
): Promise<string | undefined> {
  const { answer, decided, configured, runtime } = read;
  const { built } = part;
  const coded = partCodingFailure(answer, read.coding, heldCodings(part, runtime));
  if (coded !== undefined) {
    return coded;
  }
  if (!runtime) {
    if (built === undefined) {
      return `answered ${answer.length} bytes not marked as a runtime generation's, though the build wrote none`;
    }
    if (answer.sha256 !== built.sha256 || answer.length !== built.byteLength) {
      return `answered ${answer.length} bytes other than the ${built.byteLength} the build wrote`;
    }
  }
  const unvaried = variesBy(answer, PART_VARY[part.kind]);
  const visitors = oneVisitors(answer, configured, runtime);
  const marked =
    partTypeFailure(part, answer, configured, runtime) ??
    (unvaried === undefined ? undefined : `answered under no Vary naming ${unvaried}`) ??
    markedFailure(part, answer.headers, {
      runtime,
      cacheMarked: setByApplication(CACHE_HEADER, configured, decided),
    });
  return (
    marked ??
    (await recordedAppliedFailure(stack, part, {
      answer,
      configured,
      decided,
      visitors,
      runtime,
      within: read.within,
    })) ??
    (visitors ? sharedCacheFailure(answer, () => false) : undefined) ??
    policyFailure(stack, answer)
  );
}
