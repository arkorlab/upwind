import { pageHeaders } from '@stayingupwind/core/bundle';
import {
  deriveEntry,
  staticPageDataHeadersAllowSharing,
  staticPageHasNoTransform,
  staticPageHeadersAllowSharing,
} from '@stayingupwind/core/cache';
import type { ConfiguredHeaders, StaticPageEntry } from '@stayingupwind/core/manifest';
import {
  CACHE_ENTRY_HEADER,
  CACHE_ROUTE_HEADER,
  CACHE_ROUTE_ESCAPED_HEADER,
  pathHeaders,
  REGENERATE_HEADER,
} from '@stayingupwind/core/paas';
import {
  classifyRequest,
  EDGE_DEBUG_HEADER,
  manifestIdPrefix,
  type RequestClass,
  varyOn,
  removeSharedCacheOverrides,
  REVALIDATE_CACHE_CONTROL,
} from '@stayingupwind/core/request';
import { releaseStream, withDeadline } from '@stayingupwind/core/util';
import {
  runtimeCacheOf,
  type ResolvedPolicy,
  type RuntimeCacheSettings,
} from '@stayingupwind/host/delivery';

import { condemnedIn } from '../cache/condemned.ts';
import { decideGeneration, type GenerationDecision } from '../cache/decision.ts';
import { loadGeneration, readServedAgain } from '../cache/generation-hold.ts';
import { foregroundDocument, shouldAsk } from '../cache/regenerate.ts';
import { memberEntryKey } from '../memory/caches.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { loadShell, storageReadsOf } from '../strategies/shell-loader.ts';
import { layStoredConfiguredOver, withJudgedRules } from './configured-headers.ts';
import { applyCspReporting } from './csp-reporting-headers.ts';
import { ACCEPT_ENCODING_HEADER, IDENTITY_ENCODING } from './document-headers.ts';
import { serveAfterMiddleware } from './hosted-gate.ts';
import { offTheEdge } from './hosted-route.ts';
import { observeMetric } from './observer.ts';
import { handlePassthrough, PATTERN_BUDGET } from './passthrough.ts';
import { chosenRendering, closedStream } from './segment.ts';
import { capturePairedPageData, refreshMissingPairedPage } from './static-page-capture.ts';
import { servePairedPageData } from './static-page-data.ts';
import { requestAllowsSharing, serveCurrentPage, type StaticPageInput } from './static-page.ts';

const FALLBACK_PRIVACY = 3;
const CONTENT_ENCODING = 'content-encoding';
const HTTP_OK = 200;
const FIRST_MEMBER_CAPTURE_METRIC_MS = 5000;
const PAGES_DATA = 'pages-data';
const PRIVATE_PAGE = 'static-page-private';
const noDispatches = (): number => 0;

type PageClass = Extract<RequestClass, { kind: 'static-page' | 'pages-fallback' }>;
type LazyClass = Extract<PageClass, { kind: 'pages-fallback' }>;

export interface FallbackPageInput extends Omit<StaticPageInput, 'entry'> {
  readonly classification: PageClass;
  readonly resolved: ResolvedPolicy<EdgeContext>;
}

interface Chosen {
  readonly input: StaticPageInput;
  readonly lazy: LazyClass | undefined;
  readonly data: boolean;
}

async function choose(input: FallbackPageInput): Promise<Chosen | undefined> {
  const classification = classifyRequest({
    method: input.request.method,
    url: input.url,
    headers: input.classifiedHeaders,
    manifest: input.manifest,
    deployment: input.manifest.deployment,
  });
  if (
    classification.kind === 'static-page' &&
    classification.entry.staticPagePrivacy === FALLBACK_PRIVACY
  ) {
    return {
      input: { ...input, entry: classification.entry },
      lazy: undefined,
      data: classification.representation === PAGES_DATA,
    };
  }
  const scopeId = input.manifest.cache?.scopeId;
  if (scopeId === undefined || classification.kind !== 'pages-fallback') return undefined;
  const key = memberEntryKey(scopeId, classification.entry.route, classification.pathname);
  let entryId = input.edge.runtime.memory.memberEntries.get(key);
  if (entryId === undefined) {
    entryId = (
      await deriveEntry(scopeId, {
        kind: 'pages',
        route: classification.entry.route,
        pathname: classification.pathname,
      })
    ).entryId;
    input.edge.runtime.memory.memberEntries.set(key, entryId);
  }
  const entry: StaticPageEntry = {
    staticPagePrivacy: FALLBACK_PRIVACY,
    entryId,
    route: classification.entry.route,
    pathname: classification.pathname,
    parameters: { ...classification.parameters },
    dataPathname: classification.dataPathname,
    ...(classification.entry.function !== undefined && { function: classification.entry.function }),
    ...(classification.entry.bypassFor !== undefined && {
      bypassFor: classification.entry.bypassFor,
    }),
  };
  return {
    input: { ...input, entry },
    lazy: classification,
    data: classification.representation === PAGES_DATA,
  };
}

function configuredAgrees(configured: ConfiguredHeaders, data: boolean): boolean {
  return (
    !configured.conditioned &&
    (data ? staticPageDataHeadersAllowSharing : staticPageHeadersAllowSharing)(
      Object.entries(configured.headers),
    )
  );
}

function loadingPoint(
  input: StaticPageInput,
  startedAt: number,
  source: string,
  counts: { readonly bytes: number; readonly reads: number; readonly encoding?: string },
): EdgeMetric {
  const { edge } = input;
  return {
    projectId: edge.projectId,
    kind: 'document',
    pathname: input.entry.pathname,
    shellStrategy: 'fallback',
    shellSource: source,
    outcomeKind: 'pages-fallback-loading',
    colo: edge.colo ?? '',
    originCacheHeader: '',
    manifestId: edge.manifestId,
    policyId: edge.policy.id,
    encoding: counts.encoding ?? IDENTITY_ENCODING,
    ttfbInternalMs: edge.runtime.now() - startedAt,
    shellLookupMs: 0,
    recordLookupMs: 0,
    originFirstByteMs: 0,
    originTotalMs: 0,
    shellBytes: counts.bytes,
    suffixBytes: 0,
    recovery: 0,
    retry: 0,
    assetHit: 0,
    subrequests: counts.reads,
    pointerLookupMs: edge.timings.pointerMs,
    manifestLookupMs: edge.timings.manifestMs,
  };
}

async function settled(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // Background capture failures do not alter the already selected loading shell.
  }
}

interface PageDelivery {
  readonly configured: ConfiguredHeaders;
  readonly settings: RuntimeCacheSettings;
  readonly startedAt: number;
  readonly dispatches: number;
}

/** A first member has no generation to replace; neither a class id nor a pack is invented. */
function startFirstMember(
  input: StaticPageInput,
  settings: RuntimeCacheSettings,
  point: EdgeMetric,
): void {
  const { edge, entry } = input;
  if (!shouldAsk(edge, entry.entryId, settings)) {
    observeMetric(edge.host, point);
    return;
  }
  let dispatched = noDispatches;
  const operation = (async (): Promise<void> => {
    const response = await handlePassthrough({
      request: new Request(input.request, { signal: null }),
      forwarding: edge.forwarding,
      runtime: edge.runtime,
      host: edge.host,
      app: edge.app,
      function: entry.function,
      scopeId: input.manifest.cache?.scopeId,
      reason: 'pages-fallback-capture',
      headers: {
        [REGENERATE_HEADER]: 'detached',
        [CACHE_ENTRY_HEADER]: entry.entryId,
        ...pathHeaders(CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER, entry.route),
      },
      onAsked: (read) => {
        dispatched = read;
      },
    });
    releaseStream(response.body, 'first member capture accepted');
  })();
  edge.ctx.waitUntil(settled(operation));
  edge.ctx.waitUntil(
    (async (): Promise<void> => {
      try {
        await withDeadline(operation, FIRST_MEMBER_CAPTURE_METRIC_MS, 'first Pages member capture');
      } catch {
        // The metric is still emitted when detached capture exceeds its observation deadline.
      } finally {
        observeMetric(edge.host, { ...point, subrequests: point.subrequests + dispatched() });
      }
    })(),
  );
}

async function loadingPage(
  input: FallbackPageInput,
  chosen: Chosen,
  delivery: PageDelivery,
): Promise<Response> {
  const { configured, settings, startedAt, dispatches } = delivery;
  const { lazy } = chosen;
  if (lazy === undefined) return input.passthrough('static-page-not-fresh');
  const headers = new Headers(lazy.entry.headers);
  layStoredConfiguredOver(
    headers,
    configured,
    input.edge.forwarding,
    new Set(['content-length', 'content-range', CONTENT_ENCODING, 'etag']),
  );
  if (!staticPageHeadersAllowSharing(headers))
    return input.passthrough('static-page-response-private');
  const selected = chosenRendering({ request: input.request, segment: lazy.entry.shell });
  const first = await loadShell(selected.ref, input.resolved.shell, input.edge);
  const fallback =
    first.kind === 'ok' || selected.encoding === IDENTITY_ENCODING
      ? undefined
      : await loadShell(lazy.entry.shell.artifact, input.resolved.shell, input.edge);
  const loaded = fallback ?? first;
  if (loaded.kind !== 'ok') return input.passthrough('pages-fallback-shell-unavailable');
  const rendering =
    fallback === undefined
      ? selected
      : { ref: lazy.entry.shell.artifact, encoding: IDENTITY_ENCODING, close: undefined };
  const length = loaded.read.bytes.byteLength + (rendering.close?.byteLength ?? 0);
  const noTransform = staticPageHasNoTransform(headers);
  for (const name of [CONTENT_ENCODING, 'content-range', 'accept-ranges', 'etag'])
    headers.delete(name);
  removeSharedCacheOverrides(headers);
  headers.set('cache-control', `${REVALIDATE_CACHE_CONTROL}${noTransform ? ', no-transform' : ''}`);
  headers.set('content-type', lazy.entry.shell.artifact.contentType);
  headers.set('content-length', String(length));
  varyOn(headers, ACCEPT_ENCODING_HEADER);
  if (rendering.encoding !== IDENTITY_ENCODING) headers.set(CONTENT_ENCODING, rendering.encoding);
  applyCspReporting(headers, input.edge.cspReportingPath);
  headers.set(
    EDGE_DEBUG_HEADER,
    `pages-fallback;src=${loaded.read.source};m=${manifestIdPrefix(input.edge.manifestId)}`,
  );
  const response = new Response(closedStream(loaded.read.bytes, rendering.close), {
    status: HTTP_OK,
    headers,
    ...(rendering.encoding !== IDENTITY_ENCODING && { encodeBody: 'manual' as const }),
  });
  startFirstMember(
    chosen.input,
    settings,
    loadingPoint(chosen.input, startedAt, loaded.read.source, {
      bytes: length,
      reads:
        dispatches +
        storageReadsOf(first) +
        (fallback === undefined ? 0 : storageReadsOf(fallback)),
      encoding: rendering.encoding,
    }),
  );
  refreshMissingPairedPage(chosen.input, settings);
  return response;
}

function observePrivateCapture(
  input: StaticPageInput,
  delivery: PageDelivery,
  reads: number,
): void {
  const point = loadingPoint(input, delivery.startedAt, 'origin', {
    bytes: 0,
    reads: delivery.dispatches + reads,
  });
  observeMetric(input.edge.host, {
    ...point,
    kind: 'data',
    shellStrategy: 'passthrough',
    outcomeKind: 'pages-data-capture-private',
  });
}

async function dataPage(
  chosen: Chosen,
  decision: GenerationDecision,
  delivery: PageDelivery,
): Promise<Response> {
  const { configured, settings, startedAt, dispatches } = delivery;
  const { input } = chosen;
  const scopeId = input.manifest.cache?.scopeId;
  if (scopeId === undefined) return input.passthrough('static-page-cache-disabled');
  if (
    decision.kind === 'serve' &&
    decision.validity !== 'unknown' &&
    decision.pack.header.invalidation === undefined &&
    pageHeaders(decision.pack, input.entry, scopeId) !== undefined
  ) {
    return (
      (await servePairedPageData(input, {
        decision,
        configured,
        settings,
        startedAt,
        dispatches,
      })) ?? input.passthrough('pages-data-record-unavailable')
    );
  }
  if (decision.kind !== 'build' && decision.kind !== 'regenerate') {
    return input.passthrough('pages-data-record-unproved');
  }
  if (
    decision.kind === 'regenerate' &&
    pageHeaders(decision.pack, input.entry, scopeId) === undefined
  ) {
    return input.passthrough('pages-data-record-unproved');
  }
  const captured = await capturePairedPageData(
    input,
    decision.kind === 'regenerate' ? decision.pack : undefined,
    chosen.lazy !== undefined && decision.kind === 'build' && decision.reason === 'no-record',
  );
  if (captured.decision === undefined) {
    observePrivateCapture(input, delivery, captured.dispatches + captured.authorityReads);
    return captured.response;
  }
  const response = await servePairedPageData(input, {
    decision: captured.decision,
    configured,
    settings,
    startedAt,
    dispatches: dispatches + captured.dispatches + captured.authorityReads,
  });
  if (response === undefined) {
    observePrivateCapture(input, delivery, captured.dispatches + captured.authorityReads);
    return captured.response;
  }
  releaseStream(captured.response.body, 'paired generation replaces private capture response');
  return response;
}

async function serve(
  input: FallbackPageInput,
  configured: ConfiguredHeaders,
  dispatches: number,
): Promise<Response> {
  const data = input.classification.representation === PAGES_DATA;
  if (!requestAllowsSharing(input) || !configuredAgrees(configured, data))
    return input.passthrough(PRIVATE_PAGE);
  const chosen = await choose(input);
  if (chosen === undefined) return input.passthrough('static-page-unproved');
  const withheld =
    offTheEdge(input.edge, { pathname: chosen.input.entry.route }) ??
    offTheEdge(input.edge, chosen.input.entry);
  if (withheld !== undefined) return input.passthrough(withheld);
  const settings = runtimeCacheOf(input.edge.policy);
  const scopeId = input.manifest.cache?.scopeId;
  if (scopeId === undefined || settings.generations !== 'on')
    return input.passthrough('static-page-cache-disabled');
  const startedAt = input.edge.runtime.now();
  const load = await loadGeneration(
    input.edge,
    { scopeId, entryId: chosen.input.entry.entryId },
    settings,
    { holdAbsence: true },
  );
  const decision = decideGeneration(
    load,
    input.edge.runtime.now(),
    condemnedIn(input.edge.runtime.memory, input.edge.app?.deploymentId),
  );
  const delivery = { configured, settings, startedAt, dispatches };
  if (chosen.data) return dataPage(chosen, decision, delivery);
  if (load.kind === 'none' && chosen.lazy !== undefined)
    return loadingPage(input, chosen, delivery);
  if (
    (decision.kind !== 'serve' && decision.kind !== 'regenerate') ||
    (decision.kind === 'serve' && decision.validity === 'unknown')
  )
    return input.passthrough('static-page-not-fresh');
  const headers = pageHeaders(decision.pack, chosen.input.entry, scopeId);
  if (headers === undefined) return input.passthrough('static-page-record-unproved');
  if (decision.kind === 'regenerate') {
    readServedAgain(input.edge, decision.pack, settings);
    return foregroundDocument(
      input.edge,
      {
        request: input.request,
        middleware: undefined,
        target: { pack: decision.pack, entryId: chosen.input.entry.entryId },
        function: chosen.input.entry.function,
      },
      { recordLookupMs: decision.lookupMs },
    );
  }
  if (decision.pack.header.invalidation !== undefined)
    return input.passthrough('static-page-invalidated');
  return serveCurrentPage(chosen.input, {
    entry: chosen.input.entry,
    decision,
    headers,
    configured,
    settings,
    startedAt,
    dispatches,
  });
}

/** Independent version-three routing; old Pages capabilities keep their existing serving path. */
export function routeHostedFallbackPage(input: FallbackPageInput): Promise<Response> {
  if (input.request.method !== 'GET') return input.passthrough('static-page-head');
  return serveAfterMiddleware(input, {
    overBudget: (middleware, _dispatches, configured) => {
      return input.passthrough(
        PATTERN_BUDGET,
        middleware === undefined
          ? undefined
          : withJudgedRules(middleware, configured, input.manifest),
      );
    },
    serve: (middleware, dispatches, configured) => {
      return middleware === undefined
        ? serve(input, configured, dispatches)
        : input.passthrough(PRIVATE_PAGE, middleware);
    },
    rewritten: (middleware, _dispatches, configured) => {
      return input.passthrough(
        'static-page-private',
        withJudgedRules(middleware, configured, input.manifest),
      );
    },
  });
}
