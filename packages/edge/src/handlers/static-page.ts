import { staticPageHeadersAllowSharing, staticPageHasNoTransform } from '@stayingupwind/core/cache';
import type { ConfiguredHeaders, StaticPageEntry } from '@stayingupwind/core/manifest';
import {
  classifyRequest,
  EDGE_DEBUG_HEADER,
  manifestIdPrefix,
  removeSharedCacheOverrides,
  REVALIDATE_CACHE_CONTROL,
} from '@stayingupwind/core/request';
import { withoutHostCredentials } from '@stayingupwind/host/credentials';
import { runtimeCacheOf, type RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import { condemnedIn } from '../cache/condemned.ts';
import { decideGeneration, type GenerationDecision } from '../cache/decision.ts';
import { loadGeneration, readServedAgain } from '../cache/generation-hold.ts';
import { foregroundDocument, shouldAsk, triggerDetached } from '../cache/regenerate.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import { layStoredConfiguredOver, withJudgedRules } from './configured-headers.ts';
import { applyCspReporting } from './csp-reporting-headers.ts';
import { type HostedGateInput, serveAfterMiddleware, type TimedContinue } from './hosted-gate.ts';
import { offTheEdge } from './hosted-route.ts';
import { observeMetric, observeServed } from './observer.ts';
import { PATTERN_BUDGET, type PassthroughWait } from './passthrough.ts';
import { htmlType, pageHeaders } from './static-page-record.ts';

/** Only a sealed mapping and an independently proved current record authorize static HTML. */
export interface StaticPageInput extends HostedGateInput {
  readonly entry: StaticPageEntry;
  readonly classifiedHeaders: Headers;
  readonly passthrough: (
    reason: string,
    middleware?: Parameters<HostedGateInput['passthrough']>[1],
    waited?: PassthroughWait,
  ) => Promise<Response>;
}

const HTTP_OK = 200;
const CACHE_CONTROL = 'cache-control';
const CONTENT_TYPE = 'content-type';
const ENTITY_HEADERS: ReadonlySet<string> = new Set([
  'accept-ranges',
  'content-encoding',
  'content-length',
  'content-range',
  'etag',
]);
const CONDITIONAL_HEADERS = [
  'range',
  'if-range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
] as const;

/** No privacy evidence may disappear in the configured-header transport filter. */
export function configuredAllowsSharing(configured: ConfiguredHeaders): boolean {
  return (
    !configured.conditioned && staticPageHeadersAllowSharing(Object.entries(configured.headers))
  );
}

export function requestAllowsSharing(
  input: Pick<StaticPageInput, 'edge' | 'request' | 'classifiedHeaders'>,
): boolean {
  const { edge, request, classifiedHeaders } = input;
  if (edge.privateDelivery || edge.validated || edge.cspNonce) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  for (const headers of [request.headers, classifiedHeaders]) {
    // What the host keeps for itself is never the application's, so it makes no page private.
    const application = withoutHostCredentials(new Headers(headers), edge.host.credentials);
    if (application.has('cookie') || application.has('authorization')) return false;
    if (CONDITIONAL_HEADERS.some((name) => application.has(name))) return false;
  }
  return true;
}

function pageDecisionAgrees(
  decision: GenerationDecision,
  isr: boolean,
): decision is Extract<GenerationDecision, { kind: 'serve' | 'regenerate' }> {
  if (decision.kind === 'regenerate') return isr;
  return (
    decision.kind === 'serve' &&
    decision.validity !== 'unknown' &&
    (isr || decision.validity === 'fresh')
  );
}

async function servePage(
  input: StaticPageInput,
  decided: TimedContinue | undefined,
  dispatches: number,
  configured: ConfiguredHeaders,
): Promise<Response> {
  const { edge, manifest } = input;
  const middleware =
    decided === undefined ? undefined : withJudgedRules(decided, configured, manifest);
  // A middleware's decision is visitor-specific; shared HTML cannot depend on that decision.
  if (
    middleware !== undefined ||
    !requestAllowsSharing(input) ||
    !configuredAllowsSharing(configured)
  ) {
    return input.passthrough('static-page-private', middleware);
  }
  const classification = classifyRequest({
    method: input.request.method,
    url: input.url,
    headers: input.classifiedHeaders,
    manifest,
    deployment: manifest.deployment,
  });
  if (classification.kind !== 'static-page') {
    return input.passthrough('static-page-unproved');
  }
  const { entry } = classification;
  const withheld = offTheEdge(edge, entry);
  if (withheld !== undefined) return input.passthrough(withheld);
  const settings = runtimeCacheOf(edge.policy);
  if (manifest.cache === undefined || settings.generations !== 'on') {
    return input.passthrough('static-page-cache-disabled');
  }
  const startedAt = edge.runtime.now();
  const load = await loadGeneration(
    edge,
    { scopeId: manifest.cache.scopeId, entryId: entry.entryId },
    settings,
  );
  const decision = decideGeneration(
    load,
    edge.runtime.now(),
    condemnedIn(edge.runtime.memory, edge.app?.deploymentId),
  );
  const isr = entry.staticPagePrivacy === 2;
  if (!pageDecisionAgrees(decision, isr)) {
    return input.passthrough('static-page-not-fresh', undefined, {
      recordLookupMs: decision.lookupMs,
    });
  }
  const headers = pageHeaders(decision.pack, entry, manifest.cache.scopeId);
  if (headers === undefined) {
    return input.passthrough('static-page-record-unproved', undefined, {
      recordLookupMs: decision.lookupMs,
    });
  }
  const target = { pack: decision.pack, entryId: entry.entryId };
  if (decision.kind === 'regenerate') {
    readServedAgain(edge, decision.pack, settings);
    return foregroundDocument(
      edge,
      { request: input.request, middleware: undefined, target, function: entry.function },
      { recordLookupMs: decision.lookupMs },
    );
  }
  // Time-stale Pages ISR is shareable; a carried invalidation keeps the existing private path.
  if (isr && decision.pack.header.invalidation !== undefined) {
    return input.passthrough('static-page-invalidated', undefined, {
      recordLookupMs: decision.lookupMs,
    });
  }
  return serveCurrentPage(input, {
    entry,
    decision,
    headers,
    configured,
    settings,
    startedAt,
    dispatches,
  });
}

export function serveCurrentPage(
  input: StaticPageInput,
  current: {
    readonly entry: StaticPageEntry;
    readonly decision: Extract<GenerationDecision, { kind: 'serve' }>;
    readonly headers: Headers;
    readonly configured: ConfiguredHeaders;
    readonly settings: RuntimeCacheSettings;
    readonly startedAt: number;
    readonly dispatches: number;
  },
): Response | Promise<Response> {
  const { edge } = input;
  const { entry, decision, headers, configured, settings, startedAt, dispatches } = current;
  const noTransform =
    staticPageHasNoTransform(headers) ||
    staticPageHasNoTransform(Object.entries(configured.headers));
  layStoredConfiguredOver(headers, configured, edge.forwarding, ENTITY_HEADERS);
  if (!htmlType(headers.get(CONTENT_TYPE) ?? '') || !staticPageHeadersAllowSharing(headers)) {
    return input.passthrough('static-page-response-private', undefined, {
      recordLookupMs: decision.lookupMs,
    });
  }
  removeSharedCacheOverrides(headers);
  headers.set(CACHE_CONTROL, `${REVALIDATE_CACHE_CONTROL}${noTransform ? ', no-transform' : ''}`);
  applyCspReporting(headers, edge.cspReportingPath);
  headers.set(
    EDGE_DEBUG_HEADER,
    `static-page;src=${decision.source};m=${manifestIdPrefix(edge.manifestId)}`,
  );
  const response = new Response(decision.pack.html, {
    status: HTTP_OK,
    headers,
  });
  if (decision.readBytes !== undefined) observeServed(edge.host, decision.readBytes);
  const point: EdgeMetric = {
    projectId: edge.projectId,
    kind: 'document',
    pathname: entry.pathname,
    shellStrategy: '',
    shellSource: decision.source,
    outcomeKind: `static-page-${decision.validity}`,
    colo: edge.colo ?? '',
    originCacheHeader: '',
    manifestId: edge.manifestId,
    policyId: edge.policy.id,
    encoding: '',
    ttfbInternalMs: edge.runtime.now() - startedAt,
    shellLookupMs: 0,
    recordLookupMs: decision.lookupMs,
    originFirstByteMs: 0,
    originTotalMs: 0,
    shellBytes: decision.pack.html.byteLength,
    suffixBytes: 0,
    recovery: 0,
    retry: 0,
    assetHit: 0,
    subrequests: dispatches,
    pointerLookupMs: edge.timings.pointerMs,
    manifestLookupMs: edge.timings.manifestMs,
  };
  const stale = decision.validity === 'stale';
  if (stale && shouldAsk(edge, entry.entryId, settings)) {
    triggerDetached(
      edge,
      {
        request: input.request,
        middleware: undefined,
        target: { pack: decision.pack, entryId: entry.entryId },
        function: entry.function,
      },
      { attributeFunction: true },
    ).record(point);
  } else {
    observeMetric(edge.host, point);
  }
  if (stale) readServedAgain(edge, decision.pack, settings, { servedStale: true });
  return response;
}

/** Reuse the existing routing gate and current-record read, with no HTML rewriting or new RPC. */
export function routeHostedStaticPage(input: StaticPageInput): Promise<Response> {
  // The initial capability proves a GET representation. HEAD keeps its existing Function path.
  if (input.request.method === 'HEAD') return input.passthrough('static-page-head');
  return serveAfterMiddleware(input, {
    overBudget: (middleware, _dispatches, configured) => {
      return input.passthrough(
        PATTERN_BUDGET,
        middleware === undefined
          ? undefined
          : withJudgedRules(middleware, configured, input.manifest),
      );
    },
    serve: (middleware, dispatches, configured) =>
      servePage(input, middleware, dispatches, configured),
    rewritten: (middleware, dispatches, configured) =>
      servePage(input, middleware, dispatches, configured),
  });
}
