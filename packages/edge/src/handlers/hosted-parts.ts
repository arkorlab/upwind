import { deriveEntry, type DecodedGenerationPack } from '@stayingupwind/core/cache';
import {
  type ConfiguredHeaders,
  foldedHeadersFor,
  headerRulesFor,
  type ProjectManifest,
  type RouteEntry,
  type RouteSegment,
} from '@stayingupwind/core/manifest';
import {
  dataRequestHeaders,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  RSC_HEADER,
} from '@stayingupwind/core/request';
import {
  type ResolvedPolicy,
  runtimeCacheOf,
  type ShellDeliveryStrategy,
} from '@stayingupwind/host/delivery';

import { condemnedIn } from '../cache/condemned.ts';
import { decideGeneration } from '../cache/decision.ts';
import { generationAsHeld } from '../cache/generation-hold.ts';
import type { GenerationLoad } from '../cache/generation-loader.ts';
import { upgradesMember } from '../cache/member.ts';
import { shouldAsk, triggerDetached } from '../cache/regenerate.ts';
import { memberEntryKey } from '../memory/caches.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { generationKeyOf, requestAsLeft } from './hosted-route.ts';
import type { MiddlewareOutcome } from './middleware.ts';
import { handleSegment, type RouterPart } from './segment.ts';

/**
 * Router prefetches, whole Flight and Pages Router props selected after middleware routing.
 * Build parts accompany build HTML; runtime parts accompany the same held generation's HTML.
 */

/** What a hosted request of the client's router brings to answering it. */
export interface PartInput {
  readonly request: Request<unknown, IncomingRequestCfProperties>;
  readonly url: URL;
  readonly edge: EdgeContext;
  readonly manifest: ProjectManifest;
  readonly resolved: ResolvedPolicy<EdgeContext>;
  readonly passthrough: (
    reason: string,
    middleware?: MiddlewareOutcome,
    route?: string,
  ) => Promise<Response>;
}

const SEGMENT_PREFETCH = 'segment-prefetch';
const RSC_PAYLOAD = 'rsc-payload';
const PAGES_DATA = 'pages-data';
const RSC_ROLE = 'rsc';

type PartGeneration =
  | { readonly kind: 'build' }
  | {
      readonly kind: 'runtime';
      readonly pack: DecodedGenerationPack;
      readonly validity: 'fresh' | 'stale' | 'unknown';
    }
  | { readonly kind: 'function' };

/** Read the same held generation as HTML, without another metadata read behind a prefetch. */
async function partGeneration(
  input: PartInput,
  { entry, pathname, kind, held }: PartAnswer,
): Promise<PartGeneration> {
  let key = generationKeyOf(input, entry);
  if (key === undefined) return { kind: 'build' };
  const settings = runtimeCacheOf(input.edge.policy);
  // A class record does not prove the Flight of a concrete member. Without a selected member
  // record or the policy that reads one, leave that request to the Function.
  const member = entry.pathname.includes('[') && entry.pathname !== pathname;
  if (kind === 'payload' && held === undefined && member && !settings.concreteUpgrade) {
    return { kind: 'function' };
  }
  // Read an upgraded member's own generation; the class pack cannot describe its parts.
  if (held === undefined && upgradesMember(settings, entry, pathname)) {
    const route = entry.cache?.route ?? entry.pathname;
    const memoryKey = memberEntryKey(key.scopeId, route, pathname);
    let entryId = input.edge.runtime.memory.memberEntries.get(memoryKey);
    if (entryId === undefined) {
      entryId = (await deriveEntry(key.scopeId, { kind: 'app-page', route, pathname })).entryId;
      input.edge.runtime.memory.memberEntries.set(memoryKey, entryId);
    }
    key = { scopeId: key.scopeId, entryId };
  }
  const load = held ?? (await generationAsHeld(input.edge, key, settings));
  const decision = decideGeneration(
    load,
    input.edge.runtime.now(),
    condemnedIn(input.edge.runtime.memory),
  );
  if (decision.kind === 'build') {
    return { kind: upgradesMember(settings, entry, pathname) ? 'function' : 'build' };
  }
  if (decision.kind !== 'serve') return { kind: 'function' };
  if (decision.pack.header.source === 'build') {
    return { kind: decision.validity === 'fresh' ? 'build' : 'function' };
  }
  return { kind: 'runtime', pack: decision.pack, validity: decision.validity };
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
  readonly onUnavailable?: (() => Promise<Response>) | undefined;
}

/** What a page's props are recorded with: nothing — a Pages Router page records no headers. */
const NOTHING_RECORDED: Readonly<Record<string, string>> = {};

function configuredHeadersForPart(input: PartInput, answered: Answer): ConfiguredHeaders {
  const configured = headerRulesFor(
    input.manifest,
    input.url,
    answered.kind === 'data' ? dataRequestHeaders(input.request.headers) : input.request.headers,
  );
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
}

const PART_ROLES = { segment: 'segment', payload: RSC_ROLE, data: PAGES_DATA } as const;

/** Stale router-only traffic refreshes the same entry, without waiting for its regeneration. */
function refreshPart(
  input: PartInput,
  part: PartAnswer,
  generation: Extract<PartGeneration, { kind: 'runtime' }>,
): void {
  const { pack } = generation;
  const entryId = pack.header.entryId;
  if (!shouldAsk(input.edge, entryId, runtimeCacheOf(input.edge.policy))) return;
  // A Pages data URL is not the page's ISR entry pathname. Other requests retain their
  // concrete pathname so the Function can apply its own class/keyed-parameter rules.
  const request =
    part.kind === 'data'
      ? new Request(new URL(pack.header.pathname, input.request.url), input.request)
      : input.request;
  triggerDetached(input.edge, {
    request,
    middleware: part.middleware.kind === 'continue' ? part.middleware : undefined,
    function: part.entry.function,
    target: {
      pack,
      entryId,
      member: part.entry.pathname.includes('[') && !pack.header.pathname.includes('['),
    },
  });
}

async function answerPart(input: PartInput, part: PartAnswer): Promise<Response> {
  const { entry, middleware, kind, representationKey, buildPart, startedAt, reason } = part;
  const fallback = () => input.passthrough(reason, middleware, entry.pathname);
  const generation = await partGeneration(input, part);
  if (generation.kind === 'function') return fallback();
  if (generation.kind === 'build') {
    return buildPart === undefined
      ? fallback()
      : answer(input, {
          entry,
          middleware,
          kind,
          segment: buildPart,
          startedAt,
        });
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
  if (generation.validity === 'stale') refreshPart(input, part, generation);
  // loadShell retains the existing memory / Cache API race and hash verification. No authority read.
  const strategy: ShellDeliveryStrategy<EdgeContext> = {
    id: 'r2',
    async getShell(_ref, ctx) {
      const began = ctx.runtime.now();
      const object = await ctx.env.ARTIFACTS.get(storageRef);
      if (object === null) return;
      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        source: 'r2',
        latencyMs: ctx.runtime.now() - began,
      };
    },
  };
  return answer(input, {
    entry,
    middleware,
    kind,
    startedAt,
    generation,
    strategy,
    onUnavailable: fallback,
    segment: {
      artifact: {
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
        contentType: artifact.contentType,
        encoding: 'identity',
      },
    },
  });
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
  held?: GenerationLoad,
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
    held,
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
