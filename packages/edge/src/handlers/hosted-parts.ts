import {
  deriveEntry,
  type DecodedGenerationPack,
  admitPublication,
  publicationExpired,
  publicationForBuild,
  publicationForRoute,
} from '@stayingupwind/core/cache';
import {
  type ConfiguredHeaders,
  foldedHeadersFor,
  headerRulesFor,
  type ProjectManifest,
  type RequestHeaderRules,
  type RouteEntry,
  type RouteSegment,
} from '@stayingupwind/core/manifest';
import {
  dataRequestHeaders,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  RSC_HEADER,
} from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';
import {
  type ResolvedPolicy,
  runtimeCacheOf,
  type ShellDeliveryStrategy,
} from '@stayingupwind/host/delivery';

import { buildWasInvalidated } from '../cache/build-invalidated.ts';
import { CacheBody } from '../cache/cache-body.ts';
import { condemnedIn, transferInvalidations } from '../cache/condemned.ts';
import { decideGeneration, type GenerationDecision } from '../cache/decision.ts';
import { generationAsHeld, readServedAgain } from '../cache/generation-hold.ts';
import type { GenerationLoad } from '../cache/generation-loader.ts';
import { upgradesMember } from '../cache/member.ts';
import { partialFallbackInHand } from '../cache/partial-fallback.ts';
import { type DetachedRegeneration, shouldAsk, triggerDetached } from '../cache/regenerate.ts';
import { lookAtScopeBehind } from '../cache/scope-signal.ts';
import { memberEntryKey } from '../memory/caches.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { finishShellBody } from '../strategies/shell-loader.ts';
import { generationKeyOf, requestAsLeft } from './hosted-route.ts';
import { dispatchedFor, type MiddlewareOutcome, routedHeaders } from './middleware.ts';
import type { PassthroughWait } from './passthrough.ts';
import { handleSegment, type RouterPart } from './segment.ts';

/**
 * Router prefetches, whole Flight and Pages Router props selected after middleware routing.
 * Build parts accompany build HTML; runtime parts accompany the same held generation's HTML.
 */

/** What a hosted request of the client's router brings to answering it. */
export interface PartInput {
  readonly headerRules?: RequestHeaderRules | undefined;
  readonly request: Request<unknown, IncomingRequestCfProperties>;
  readonly url: URL;
  readonly edge: EdgeContext;
  readonly manifest: ProjectManifest;
  readonly resolved: ResolvedPolicy<EdgeContext>;
  readonly passthrough: (
    reason: string,
    middleware?: MiddlewareOutcome,
    route?: string,
    waited?: PassthroughWait,
  ) => Promise<Response>;
}

const SEGMENT_PREFETCH = 'segment-prefetch';
const RSC_PAYLOAD = 'rsc-payload';
const PAGES_DATA = 'pages-data';
const RSC_ROLE = 'rsc';

/**
 * A member's record, read as the member's: one of its own, or the one its class completes to
 * (`keyed`, `MemberRoute.keyedBy`). Told by where it was read, not by its pathname.
 */
interface MemberRecord {
  readonly keyed: boolean;
  readonly refreshRecord?: (() => void) | undefined;
  /** The completion's cooldown, shared with its initial HTML regeneration request. */
  readonly regenerationKey?: string | undefined;
}

type PartGeneration =
  | { readonly kind: 'build'; readonly acceptedRecord?: DecodedGenerationPack | undefined }
  | {
      readonly kind: 'runtime';
      readonly pack: DecodedGenerationPack;
      readonly validity: 'fresh' | 'stale' | 'unknown';
      /** Where the record is a member's; a class's or a route's own is none. */
      readonly member: MemberRecord | undefined;
    }
  | { readonly kind: 'function' };

/**
 * A part answered from a record that asks for its regeneration — stale, or past its expiry, or a
 * stale build's handed to the Function — has the record read again behind the response a second
 * on, as a document has (`readServedAgain`). What the regeneration publishes then reaches an
 * isolate that serves the page's parts and none of its documents, which would otherwise keep the
 * old record for as long as it is asked for. A fresh record is still judged as held, with nothing
 * read behind it (`generationAsHeld`). A member's own is read as it was, its absence held.
 */
function readPartAgain(
  input: PartInput,
  pack: DecodedGenerationPack,
  member: MemberRecord | undefined,
  servedStale = false,
): void {
  if (member?.refreshRecord !== undefined) {
    member.refreshRecord();
    return;
  }
  readServedAgain(
    input.edge,
    pack,
    runtimeCacheOf(input.edge.policy),
    member === undefined ? { servedStale } : { holdAbsence: true, servedStale },
  );
}

/**
 * Read the same held generation as HTML, without another metadata read ahead of a prefetch: a
 * record that asks for its regeneration is read again only behind the response (`readPartAgain`).
 */
function partialPartGeneration(
  input: PartInput,
  { entry, pathname }: PartAnswer,
): PartGeneration | undefined {
  if (input.request.method !== 'GET' || entry.partialFallback === undefined) return undefined;
  const partial = partialFallbackInHand(input.edge, input.manifest, entry, pathname);
  if (partial !== undefined) {
    partial.refresh();
    const decision = decideGeneration(
      partial.load,
      input.edge.runtime.now(),
      condemnedIn(input.edge.runtime.memory, input.edge.app?.deploymentId),
      input.manifest.publication,
    );
    // Generic build parts do not describe a completed member's HTML. Missing or incompatible
    // representations remain with the Function, which can resume that member's own record.
    return decision.kind === 'build'
      ? { kind: 'function' }
      : partFrom(input, decision, {
          keyed: entry.partialFallback.keyedBy !== undefined,
          refreshRecord: partial.refresh,
          regenerationKey: memberEntryKey(
            input.manifest.cache?.scopeId ?? '',
            partial.route,
            partial.pathname,
          ),
        });
  }
  return undefined;
}

async function partGeneration(input: PartInput, part: PartAnswer): Promise<PartGeneration> {
  const partial = partialPartGeneration(input, part);
  if (partial !== undefined) return partial;
  const { entry, pathname, kind, held, keyed } = part;
  let key = generationKeyOf(input, entry);
  if (key === undefined) return { kind: 'build' };
  const settings = runtimeCacheOf(input.edge.policy);
  // A class record does not prove the Flight of a concrete member. Without a selected member
  // record or the policy that reads one, leave that request to the Function.
  const member = entry.pathname.includes('[') && entry.pathname !== pathname;
  if (kind === 'payload' && held === undefined && member && !settings.concreteUpgrade) {
    return { kind: 'function' };
  }
  lookAtScopeBehind(input.edge, key.scopeId);
  let own: MemberRecord | undefined = held === undefined ? undefined : { keyed: keyed === true };
  // Read an upgraded member's own generation; the class pack cannot describe its parts.
  if (held === undefined && upgradesMember(settings, entry, pathname)) {
    own = { keyed: false };
    const route = entry.cache?.route ?? entry.pathname;
    const memoryKey = memberEntryKey(key.scopeId, route, pathname);
    let entryId = input.edge.runtime.memory.memberEntries.get(memoryKey);
    if (entryId === undefined) {
      entryId = (await deriveEntry(key.scopeId, { kind: 'app-page', route, pathname })).entryId;
      input.edge.runtime.memory.memberEntries.set(memoryKey, entryId);
    }
    key = { scopeId: key.scopeId, entryId };
  }
  // A member's own is judged as its document's read is, its absence held (`startMemberRead`).
  const options = own === undefined ? {} : { holdAbsence: true };
  const load = held ?? (await generationAsHeld(input.edge, key, settings, options));
  const decision = decideGeneration(
    load,
    input.edge.runtime.now(),
    condemnedIn(input.edge.runtime.memory, input.edge.app?.deploymentId),
    input.manifest.publication,
  );
  if (decision.kind === 'build') {
    return { kind: upgradesMember(settings, entry, pathname) ? 'function' : 'build' };
  }
  return partFrom(input, decision, own);
}

/** What a part is answered from, as the record its page is judged by decides it. */
function partFrom(
  input: PartInput,
  decision: Exclude<GenerationDecision, { readonly kind: 'build' }>,
  member: MemberRecord | undefined,
): PartGeneration {
  if (decision.kind === 'regenerate') {
    readPartAgain(input, decision.pack, member);
    return { kind: 'function' };
  }
  if (decision.kind !== 'serve') return { kind: 'function' };
  if (decision.pack.header.source === 'build') {
    if (decision.validity === 'fresh') return { kind: 'build', acceptedRecord: decision.pack };
    readPartAgain(input, decision.pack, member);
    return { kind: 'function' };
  }
  return { kind: 'runtime', pack: decision.pack, validity: decision.validity, member };
}

/** What a request of the router is answered with, once it is known to be answered here. */
interface Answer {
  readonly entry: RouteEntry;
  readonly middleware: MiddlewareOutcome;
  readonly kind: RouterPart;
  readonly segment: RouteSegment;
  readonly startedAt: number;
  readonly generation?: Extract<PartGeneration, { kind: 'runtime' }> | undefined;
  readonly strategy?: ShellDeliveryStrategy<EdgeContext> | undefined;
  readonly onUnavailable?: ((storageReads: number) => Promise<Response>) | undefined;
  /** The regeneration the stale record asked for on its own (`refreshPart`). */
  readonly detached?: DetachedRegeneration | undefined;
}

/** What a page's props are recorded with: nothing — a Pages Router page records no headers. */
const NOTHING_RECORDED: Readonly<Record<string, string>> = {};

/** Forward first, then restore the data marker the router supplies rather than taking from clients. */
function routedPartHeaders(input: PartInput, answered: Answer): Headers {
  const routed = routedHeaders(input.edge, input.manifest.headerRules, input.request.headers);
  return answered.kind === 'data' ? dataRequestHeaders(routed) : routed;
}

function configuredHeadersForPart(input: PartInput, answered: Answer): ConfiguredHeaders {
  const configured =
    input.headerRules?.response ??
    headerRulesFor(input.manifest, input.url, routedPartHeaders(input, answered));
  if (
    answered.kind === 'data' ||
    (input.manifest.foldedHeaderRules === undefined &&
      input.manifest.dynamicRoutes !== undefined) ||
    Object.hasOwn(configured.headers, 'link')
  ) {
    return configured;
  }
  if (input.manifest.foldedHeaderRules === undefined) {
    // Legacy manifests without either provenance field may hold explicit rules in recorded Link.
    // Generated hints cannot be distinguished there and retain their behavior until republishing.
    for (const [name, value] of Object.entries(answered.entry.headers)) {
      if (name.toLowerCase() === 'link') {
        configured.headers['link'] = value;
      }
    }
  } else {
    // Unrouteable builds publish their folded rules apart: only their intentional Link returns.
    const link = foldedHeadersFor(input.manifest, answered.entry.pathname)?.['link'];
    if (link !== undefined) {
      configured.headers['link'] = link;
    }
  }
  return configured;
}

function answer(input: PartInput, answered: Answer): Promise<Response> {
  const { entry, middleware } = answered;
  return handleSegment({
    request: input.request,
    edge: input.edge,
    pathname: entry.pathname,
    kind: answered.kind,
    segment: answered.segment,
    // A page's props are asked for at a URL of their own, and the route's headers hold what the
    // rules of `next.config` set on the page's: the rules are judged against this URL below, as
    // Next.js's routing judges them for such a request (`routePagesData`).
    routeHeaders:
      answered.kind === 'data'
        ? NOTHING_RECORDED
        : (answered.generation?.pack.header.headers ?? entry.headers),
    // Judged on the request as it reached the edge, as the document and the shipped-file paths judge
    // them: the router runs these rules before the middleware, so neither a path it rewrote nor a
    // header it took away is what Next.js selected them with. A request for a page's props carries
    // the `x-nextjs-data` the router puts on every one, whatever the client sent.
    configured: configuredHeadersForPart(input, answered),
    strategy: answered.strategy ?? input.resolved.shell,
    generation:
      answered.generation === undefined
        ? undefined
        : {
            partial: answered.generation.pack.header.postponedSha256 !== null,
            cacheState: answered.generation.validity === 'stale' ? 'STALE' : 'HIT',
          },
    onUnavailable: answered.onUnavailable,
    middleware: middleware.kind === 'continue' ? middleware : undefined,
    middlewareDispatches: dispatchedFor(middleware),
    detached: answered.detached,
    startedAt: answered.startedAt,
  });
}

/** The authority's chosen immutable locator is included in new packs; old packs use the Function. */
interface PartAnswer {
  readonly entry: RouteEntry;
  readonly middleware: MiddlewareOutcome;
  readonly kind: RouterPart;
  readonly representationKey: string;
  readonly buildPart: RouteSegment | undefined;
  readonly pathname: string;
  readonly startedAt: number;
  readonly reason: string;
  readonly held?: GenerationLoad | undefined;
  /** The held record is the one the member's class completes to (`MemberRoute.keyedBy`). */
  readonly keyed?: boolean | undefined;
}

const PART_ROLES = { segment: 'segment', payload: RSC_ROLE, data: PAGES_DATA } as const;

/**
 * Stale router-only traffic refreshes the same entry, without waiting for its regeneration: a
 * request of its own, which the part's point counts (`DetachedRegeneration`). `undefined` where the
 * entry was asked for within the cooldown.
 */
function refreshPart(
  input: PartInput,
  part: PartAnswer,
  generation: Extract<PartGeneration, { kind: 'runtime' }>,
): DetachedRegeneration | undefined {
  const { pack } = generation;
  const entryId = pack.header.entryId;
  if (
    !shouldAsk(
      input.edge,
      generation.member?.regenerationKey ?? entryId,
      runtimeCacheOf(input.edge.policy),
    )
  )
    return undefined;
  // A Pages data URL is not the page's ISR entry pathname. Other requests retain their
  // concrete pathname so the Function can apply its own class/keyed-parameter rules.
  const request =
    part.kind === 'data'
      ? new Request(new URL(pack.header.pathname, input.request.url), input.request)
      : input.request;
  return triggerDetached(input.edge, {
    request,
    middleware: part.middleware.kind === 'continue' ? part.middleware : undefined,
    function: part.entry.function,
    target: {
      pack,
      entryId,
      member: generation.member !== undefined,
      keyed: generation.member?.keyed,
    },
  });
}

/** The immutable router part is eligible only while its build generation remains eligible. */
async function answerBuildPart(
  input: PartInput,
  part: PartAnswer,
  fallback: () => Promise<Response>,
  generation: Extract<PartGeneration, { readonly kind: 'build' }>,
): Promise<Response> {
  if (part.buildPart === undefined) return fallback();
  if (
    publicationExpired(
      part.entry.cache?.buildTags?.map((tag) => tag.value) ?? [],
      input.edge.runtime.now(),
      publicationForBuild(
        input.manifest.publication,
        part.entry.cache?.route ?? part.entry.pathname,
      ),
    )
  )
    return fallback();
  // A fresh accepted build record already proved its revision against every observed receipt.
  const key =
    generation.acceptedRecord === undefined ? generationKeyOf(input, part.entry) : undefined;
  if (key !== undefined) {
    transferInvalidations(input.edge.runtime.memory, input.edge.app?.deploymentId, key.scopeId);
  }
  if (
    key !== undefined &&
    buildWasInvalidated(input.edge.runtime.memory, key.scopeId, part.entry.cache)
  ) {
    return fallback();
  }
  const response = await answer(input, {
    entry: part.entry,
    middleware: part.middleware,
    kind: part.kind,
    segment: part.buildPart,
    startedAt: part.startedAt,
  });
  return admitPublication(
    response,
    part.entry.cache?.buildTags?.map((tag) => tag.value) ?? [],
    input.edge.runtime.now(),
    publicationForBuild(input.manifest.publication, part.entry.cache?.route ?? part.entry.pathname),
  );
}

async function answerPart(input: PartInput, part: PartAnswer): Promise<Response> {
  const { entry, middleware, kind, representationKey, startedAt, reason } = part;
  const fallback = (waited?: PassthroughWait) =>
    input.passthrough(reason, middleware, entry.pathname, waited);
  const generation = await partGeneration(input, part);
  if (generation.kind === 'function') return fallback();
  if (generation.kind === 'build') {
    return answerBuildPart(input, part, fallback, generation);
  }
  // Saved partial Flight is a static prefetch. Navigations and runtime prefetches need
  // the Function's visitor render, which resumes from its current generation's state.
  if (
    kind === 'payload' &&
    generation.pack.header.postponedSha256 !== null &&
    requestAsLeft(input, middleware).headers.get(NEXT_ROUTER_PREFETCH_HEADER) !== '1'
  ) {
    return fallback();
  }
  const role = PART_ROLES[kind];
  const artifact = generation.pack.header.artifacts.find((candidate) => {
    return (
      candidate.representationKey === representationKey &&
      candidate.role === role &&
      candidate.encoding === 'identity'
    );
  });
  const storageRef = artifact?.storageRef;
  if (artifact === undefined || storageRef === undefined) return fallback();
  const stale = generation.validity === 'stale';
  // Counted in the part's point, or in the passthrough's where the part cannot be read after all.
  const detached = stale ? refreshPart(input, part, generation) : undefined;
  if (stale) {
    readPartAgain(input, generation.pack, generation.member, true);
  }
  // loadShell retains the existing memory / Cache API race and hash verification. No authority read.
  const strategy: ShellDeliveryStrategy<EdgeContext> = {
    id: 'r2',
    async getShell(ref, ctx, reading = new CacheBody()) {
      const began = ctx.runtime.now();
      const object = await ctx.env.ARTIFACTS.get(storageRef);
      if (object === null) return;
      // Read only at the length the record gives the part: an object of another size would be
      // refused once hashed, and one of any size would be held whole first. Its size comes with it.
      if (object.size !== ref.byteLength) {
        releaseStream(object.body, 'router part of another length');
        throw new Error(`the part is stored at ${object.size} bytes, not ${ref.byteLength}`);
      }
      const pending = reading.open(new Response(object.body), ref.byteLength);
      if (pending === undefined) return;
      return {
        bytes: finishShellBody(reading, await pending, ref.byteLength),
        source: 'r2',
        latencyMs: ctx.runtime.now() - began,
      };
    },
  };
  const delivery = { delegated: false };
  const response = await answer(input, {
    entry,
    middleware,
    kind,
    startedAt,
    generation,
    strategy,
    onUnavailable: (storageReads) => {
      delivery.delegated = true;
      return fallback({ regeneration: detached, storageReads });
    },
    detached,
    segment: {
      artifact: {
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
        contentType: artifact.contentType,
        encoding: 'identity',
      },
    },
  });
  if (delivery.delegated) return response;
  return admitPublication(
    response,
    generation.pack.header.tags.map((tag) => tag.value),
    input.edge.runtime.now(),
    publicationForRoute(input.manifest.publication, part.entry.cache?.route ?? part.entry.pathname),
  );
}

/** Serve a segment belonging to the exact HTML generation this isolate holds. */
export async function composeSegment(
  input: PartInput,
  entry: RouteEntry,
  middleware: MiddlewareOutcome,
): Promise<Response> {
  const startedAt = input.edge.runtime.now();
  const left = requestAsLeft(input, middleware);
  const segmentPath =
    left.headers.get(RSC_HEADER) === '1'
      ? left.headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER)
      : null;
  if (segmentPath === null || input.request.method === 'HEAD') {
    return input.passthrough(SEGMENT_PREFETCH, middleware, entry.pathname);
  }
  // An own key only, even if a request names __proto__ or constructor.
  const buildPart =
    entry.segments !== undefined && Object.hasOwn(entry.segments, segmentPath)
      ? entry.segments[segmentPath]
      : undefined;
  return answerPart(input, {
    entry,
    middleware,
    kind: 'segment',
    representationKey: `segment:${segmentPath}`,
    buildPart,
    pathname: left.url.pathname,
    startedAt,
    reason: SEGMENT_PREFETCH,
  });
}

/** Serve the whole Flight payload from the same generation as HTML and postponed state. */
export async function composePayload(
  input: PartInput,
  entry: RouteEntry,
  middleware: MiddlewareOutcome,
  own?: { readonly held: GenerationLoad; readonly keyed: boolean },
): Promise<Response> {
  const startedAt = input.edge.runtime.now();
  const left = requestAsLeft(input, middleware);
  const whole =
    left.headers.get(RSC_HEADER) === '1' && !left.headers.has(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER);
  if (!whole || input.request.method === 'HEAD') {
    return input.passthrough(RSC_PAYLOAD, middleware, entry.pathname);
  }
  return answerPart(input, {
    entry,
    middleware,
    kind: 'payload',
    representationKey: RSC_ROLE,
    buildPart: entry.payload,
    pathname: left.url.pathname,
    startedAt,
    reason: RSC_PAYLOAD,
    held: own?.held,
    keyed: own?.keyed,
  });
}

/** A Pages Router page's props carry no recorded document headers. */
export async function composePagesData(input: PartInput, entry: RouteEntry): Promise<Response> {
  const startedAt = input.edge.runtime.now();
  if (input.request.method === 'HEAD') {
    return input.passthrough(PAGES_DATA, undefined, entry.pathname);
  }
  return answerPart(input, {
    entry,
    middleware: { kind: 'skipped', reason: 'unmatched' },
    kind: 'data',
    representationKey: PAGES_DATA,
    buildPart: entry.pagesData,
    pathname: entry.pathname,
    startedAt,
    reason: PAGES_DATA,
  });
}
