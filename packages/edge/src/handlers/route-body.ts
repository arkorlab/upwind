import type { DecodedGenerationPack } from '@stayingupwind/core/cache';
import {
  type ConfiguredHeaders,
  isReserved,
  type RouteBodyEntry,
} from '@stayingupwind/core/manifest';
import {
  classifyRequest,
  EDGE_DEBUG_HEADER,
  filterStoredResponseHeaders,
  hasRouteBodyControlHeader,
  manifestIdPrefix,
  SHARED_CACHE_CONTROL_HEADERS,
} from '@stayingupwind/core/request';
import { runtimeCacheOf, type RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import { condemnedIn } from '../cache/condemned.ts';
import { decideGeneration, type GenerationDecision } from '../cache/decision.ts';
import { loadGeneration, readServedAgain } from '../cache/generation-hold.ts';
import { foregroundDocument, shouldAsk, triggerDetached } from '../cache/regenerate.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import { layStoredConfiguredOver, withJudgedRules } from './configured-headers.ts';
import { type HostedGateInput, serveAfterMiddleware, type TimedContinue } from './hosted-gate.ts';
import { offTheEdge } from './hosted-route.ts';
import { serveHostedFile } from './hosted-static-file.ts';
import { handedHeaders } from './middleware.ts';
import { observeMetric, observeServed } from './observer.ts';
import { PATTERN_BUDGET, type PassthroughWait } from './passthrough.ts';
import {
  carriesApplicationCredentials,
  mergeScopedMiddlewareHeaders,
  removeSharedCacheOverrides,
} from './responses.ts';
import { policyRefusesSharing } from './route-body-policy.ts';

/** Only the host's manifest and authority record permit sharing; a Function's answer never does. */
export interface RouteBodyInput extends HostedGateInput {
  readonly entry: RouteBodyEntry;
  readonly classifiedHeaders: Headers;
  readonly passthrough: (
    reason: string,
    middleware?: Parameters<HostedGateInput['passthrough']>[1],
    waited?: PassthroughWait,
  ) => Promise<Response>;
}

const HTTP_OK = 200;
const REVALIDATE = 'public, max-age=0, must-revalidate';
const GATED_CACHE_CONTROL = 'private, max-age=0, must-revalidate';
const CACHE_CONTROL = 'cache-control';
const NO_TRANSFORM = 'no-transform';
const CACHE_CONTROL_FIELDS = [CACHE_CONTROL, ...SHARED_CACHE_CONTROL_HEADERS];
const CONTENT_TYPE = 'content-type';
const CONTENT_ENCODING = 'content-encoding';
const CONTENT_RANGE = 'content-range';
const SET_COOKIE = 'set-cookie';
const ROUTE_BODY = 'route-body';
const BODY_UNSHAREABLE = 'route-body-unshareable';
const ENTITY_HEADERS: ReadonlySet<string> = new Set([
  'accept-ranges',
  'content-length',
  CONTENT_ENCODING,
  CONTENT_RANGE,
  'etag',
]);
/** Conditions and ranges are still the Function's to evaluate against its own full response. */
const CONDITIONAL_HEADERS = [
  'range',
  'if-range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
] as const;
function bodyTypeAllowed(contentType: string): boolean {
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return (
    type !== undefined &&
    type !== '' &&
    !type.includes(',') &&
    type !== 'text/html' &&
    type !== 'application/xhtml+xml'
  );
}

function configuredRefusesSharing(configured: ConfiguredHeaders): boolean {
  const fields = new Map<string, string>();
  for (const [name, value] of Object.entries(configured.headers)) {
    fields.set(name.toLowerCase(), value);
  }
  return policyRefusesSharing({ get: (name) => fields.get(name) ?? null });
}

function noTransformDirective(value: string | null): boolean {
  return (
    value?.split(',').some((directive) => directive.trim().toLowerCase() === NO_TRANSFORM) === true
  );
}

function noTransform(headers: Pick<Headers, 'get'>): boolean {
  return CACHE_CONTROL_FIELDS.some((name) => noTransformDirective(headers.get(name)));
}

/** A middleware's admission is visitor-specific; safe owner policy otherwise keeps its value. */
function narrowCacheControl(
  headers: Headers,
  middleware: TimedContinue | undefined,
  untransformed: boolean,
): void {
  const existing = headers.get(CACHE_CONTROL);
  // A stored prohibition alone does not supply the missing browser revalidation policy.
  const policyMissing =
    existing === null ||
    existing.split(',').every((part) => {
      const directive = part.trim().toLowerCase();
      return directive === '' || directive === NO_TRANSFORM;
    });
  const ungated = policyMissing ? REVALIDATE : existing;
  const policy = middleware === undefined ? ungated : GATED_CACHE_CONTROL;
  headers.set(
    CACHE_CONTROL,
    `${policy}${untransformed && !noTransformDirective(policy) ? ', no-transform' : ''}`,
  );
}

function bodyArtifact(pack: DecodedGenerationPack) {
  const { header, html: body } = pack;
  const artifact = header.artifacts.find(
    (item) => item.role === ROUTE_BODY && item.representationKey === ROUTE_BODY,
  );
  if (
    artifact?.encoding !== 'identity' ||
    artifact.sha256 !== header.htmlSha256 ||
    artifact.byteLength !== body.byteLength ||
    !bodyTypeAllowed(artifact.contentType)
  ) {
    return;
  }
  return artifact;
}

/** A verified pack of another representation cannot be reinterpreted as this route's body. */
function bodyHeaders(pack: DecodedGenerationPack, entry: RouteBodyEntry): Headers | undefined {
  const { header, html: body } = pack;
  if (
    header.kind !== 'app-route' ||
    header.route !== entry.route ||
    header.pathname !== entry.pathname ||
    header.entryId !== entry.entryId ||
    header.status !== HTTP_OK ||
    pack.postponed !== undefined
  ) {
    return undefined;
  }
  const artifact = bodyArtifact(pack);
  if (artifact === undefined) return undefined;
  let headers: Headers;
  try {
    headers = new Headers(header.headers);
  } catch {
    return undefined;
  }
  const contentType = headers.get(CONTENT_TYPE) ?? artifact.contentType;
  if (!bodyTypeAllowed(contentType) || headers.has(SET_COOKIE) || policyRefusesSharing(headers)) {
    return undefined;
  }
  // Packs admit a header map, not transport semantics. Check vetoes before filtering their evidence.
  const cacheControl = headers.get(CACHE_CONTROL);
  const untransformed = noTransform(headers);
  headers = new Headers(filterStoredResponseHeaders(headers));
  if (cacheControl !== null) headers.set(CACHE_CONTROL, cacheControl);
  if (untransformed && !noTransformDirective(cacheControl)) {
    headers.set(
      CACHE_CONTROL,
      cacheControl === null || cacheControl === ''
        ? NO_TRANSFORM
        : `${cacheControl}, ${NO_TRANSFORM}`,
    );
  }
  try {
    headers.set(CONTENT_TYPE, contentType);
  } catch {
    return undefined;
  }
  headers.delete(CONTENT_ENCODING);
  headers.delete('accept-ranges');
  headers.set('content-length', String(body.byteLength));
  return headers;
}

function applicationCredentials(input: RouteBodyInput, headers: Headers): boolean {
  return carriesApplicationCredentials(headers, input.edge.host.credentials);
}

function visitorSpecific(input: RouteBodyInput, headers: Headers): boolean {
  return (
    input.edge.privateDelivery ||
    input.edge.validated ||
    applicationCredentials(input, input.classifiedHeaders) ||
    (headers !== input.classifiedHeaders && applicationCredentials(input, headers)) ||
    CONDITIONAL_HEADERS.some((name) => headers.has(name))
  );
}

function middlewareRefusesSharing(middleware: TimedContinue | undefined): boolean {
  return (
    middleware?.responseHeaders.has(SET_COOKIE) === true ||
    middleware?.setCookie !== undefined ||
    middleware?.routeBodyPrivate === true ||
    (middleware !== undefined && policyRefusesSharing(middleware.responseHeaders)) ||
    (middleware?.rewriteStatus !== undefined && middleware.rewriteStatus !== HTTP_OK)
  );
}

/** Middleware protocol inputs remain decisive before and after forwarding removes credentials. */
function controlledMiddleware(middleware: TimedContinue | undefined, headers: Headers): boolean {
  return (
    middleware !== undefined &&
    (hasRouteBodyControlHeader(middleware.requestHeaders) || hasRouteBodyControlHeader(headers))
  );
}

/** No record read for a response that belongs to one visitor or still needs HTTP conditions. */
function needsFunction(
  input: RouteBodyInput,
  headers: Headers,
  configured: ConfiguredHeaders,
  middleware: TimedContinue | undefined,
): boolean {
  return (
    visitorSpecific(input, headers) ||
    configured.conditioned ||
    configuredRefusesSharing(configured) ||
    Object.keys(configured.headers).some((name) => name.toLowerCase() === SET_COOKIE) ||
    middlewareRefusesSharing(middleware)
  );
}

function metric(
  input: RouteBodyInput,
  delivery: {
    readonly entry: RouteBodyEntry;
    readonly source: string;
    readonly validity: string;
    readonly lookupMs: number;
    readonly startedAt: number;
    readonly bytes: number;
    readonly dispatches: number;
    readonly middleware: TimedContinue | undefined;
  },
): EdgeMetric {
  const { edge } = input;
  const { entry, source, validity, lookupMs, startedAt, bytes, dispatches, middleware } = delivery;
  return {
    projectId: edge.projectId,
    kind: 'asset',
    pathname: entry.pathname,
    shellStrategy: '',
    shellSource: source,
    outcomeKind: `route-body-${validity}`,
    colo: edge.colo ?? '',
    originCacheHeader: '',
    manifestId: edge.manifestId,
    policyId: edge.policy.id,
    encoding: '',
    ttfbInternalMs: edge.runtime.now() - startedAt,
    shellLookupMs: 0,
    recordLookupMs: lookupMs,
    originFirstByteMs: 0,
    originTotalMs: 0,
    shellBytes: 0,
    suffixBytes: bytes,
    recovery: 0,
    retry: 0,
    assetHit: 0,
    subrequests: dispatches,
    middlewareMs: middleware?.middlewareMs,
    pointerLookupMs: edge.timings.pointerMs,
    manifestLookupMs: edge.timings.manifestMs,
  };
}

async function serveBody(
  input: RouteBodyInput,
  decided: TimedContinue | undefined,
  dispatches: number,
  configured: ConfiguredHeaders,
): Promise<Response> {
  const { edge, manifest } = input;
  const middleware =
    decided === undefined ? undefined : withJudgedRules(decided, configured, manifest);
  const url = middleware?.url ?? input.url;
  const headers =
    middleware === undefined
      ? input.classifiedHeaders
      : handedHeaders(edge, middleware.requestHeaders);
  // Judge middleware controls before forwarding can hide them, and before a rewrite reads a file.
  if (controlledMiddleware(middleware, headers)) {
    return input.passthrough(BODY_UNSHAREABLE, middleware);
  }
  if (middleware?.rewritten === true) {
    if (isReserved(manifest, url, headers, true)) {
      return input.passthrough('reserved', middleware);
    }
    const file = serveHostedFile({ ...input, configured }, url, middleware, dispatches);
    if (file !== undefined) return file;
  }
  const classification = classifyRequest({
    method: input.request.method,
    url,
    headers,
    manifest,
    deployment: manifest.deployment,
  });
  // Re-evaluate the request after middleware, including rewrites, pins and bypass conditions.
  if (
    classification.kind !== 'route-body' ||
    needsFunction(input, headers, configured, middleware)
  ) {
    return input.passthrough(BODY_UNSHAREABLE, middleware);
  }
  const { entry } = classification;
  const withheld = offTheEdge(edge, entry);
  if (withheld !== undefined) {
    return input.passthrough(withheld, middleware);
  }
  const settings = runtimeCacheOf(edge.policy);
  if (manifest.cache === undefined || settings.generations !== 'on') {
    return input.passthrough('route-body-cache-disabled', middleware);
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
  if (decision.kind === 'build' || decision.kind === 'passthrough') {
    return input.passthrough(`route-body-${decision.reason}`, middleware, {
      recordLookupMs: decision.lookupMs,
    });
  }
  const answered = bodyHeaders(decision.pack, entry);
  if (answered === undefined) {
    return input.passthrough('route-body-record-mismatch', middleware, {
      recordLookupMs: decision.lookupMs,
    });
  }
  const target = { pack: decision.pack, entryId: entry.entryId };
  if (decision.kind === 'regenerate') {
    readServedAgain(edge, decision.pack, settings);
    return foregroundDocument(
      edge,
      {
        request: input.request,
        middleware,
        target,
        function: entry.function,
      },
      { recordLookupMs: decision.lookupMs },
    );
  }
  return serveCurrentBody(input, {
    entry,
    decision,
    answered,
    configured,
    middleware,
    dispatches,
    settings,
    startedAt,
  });
}

/** Answer a current generation after all routing and validity decisions have completed. */
function serveCurrentBody(
  input: RouteBodyInput,
  current: {
    readonly entry: RouteBodyEntry;
    readonly decision: Extract<GenerationDecision, { kind: 'serve' }>;
    readonly answered: Headers;
    readonly configured: ConfiguredHeaders;
    readonly middleware: TimedContinue | undefined;
    readonly dispatches: number;
    readonly settings: RuntimeCacheSettings;
    readonly startedAt: number;
  },
): Promise<Response> | Response {
  const { edge } = input;
  const { entry, decision, answered, configured, middleware, dispatches, settings, startedAt } =
    current;
  const target = { pack: decision.pack, entryId: entry.entryId };
  // These are trusted generation bytes, not a public claim made on an application response.
  const recordNoTransform = noTransform(answered);
  layStoredConfiguredOver(answered, configured, edge.forwarding, ENTITY_HEADERS);
  const configuredNoTransform = noTransform(answered);
  if (middleware !== undefined) {
    mergeScopedMiddlewareHeaders(
      answered,
      middleware.responseHeaders,
      edge.forwarding,
      ENTITY_HEADERS,
    );
  }
  if (
    answered.has(SET_COOKIE) ||
    !bodyTypeAllowed(answered.get(CONTENT_TYPE) ?? '') ||
    policyRefusesSharing(answered)
  ) {
    return input.passthrough('route-body-response-unshareable', middleware, {
      recordLookupMs: decision.lookupMs,
    });
  }
  const untransformed =
    recordNoTransform ||
    configuredNoTransform ||
    noTransform(answered) ||
    (middleware !== undefined && noTransform(middleware.responseHeaders));
  removeSharedCacheOverrides(answered);
  narrowCacheControl(answered, middleware, untransformed);
  answered.set(
    EDGE_DEBUG_HEADER,
    `route-body;src=${decision.source};cache=${decision.validity};m=${manifestIdPrefix(edge.manifestId)}`,
  );
  const response = new Response(decision.pack.html, {
    status: HTTP_OK,
    headers: answered,
  });
  if (decision.readBytes !== undefined) observeServed(edge.host, decision.readBytes);
  const point = metric(input, {
    entry,
    source: decision.source,
    validity: decision.validity,
    lookupMs: decision.lookupMs,
    startedAt,
    bytes: decision.pack.html.byteLength,
    dispatches,
    middleware,
  });
  const stale = decision.validity === 'stale';
  if (stale && shouldAsk(edge, entry.entryId, settings)) {
    triggerDetached(
      edge,
      {
        request: input.request,
        middleware,
        target,
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

/** Non-document bytes use the existing gate and generation validity, with no HTML composition. */
export function routeHostedBody(input: RouteBodyInput): Promise<Response> {
  // The build proves a GET body, not that an explicit HEAD handler has identical semantics.
  if (input.request.method === 'HEAD') return input.passthrough('route-body-head');
  // Classification may have removed host credentials; original control evidence still vetoes sharing.
  if (
    hasRouteBodyControlHeader(input.request.headers) ||
    hasRouteBodyControlHeader(input.classifiedHeaders)
  ) {
    return input.passthrough(BODY_UNSHAREABLE);
  }
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
      serveBody(input, middleware, dispatches, configured),
    rewritten: (middleware, dispatches, configured) =>
      serveBody(input, middleware, dispatches, configured),
  });
}
