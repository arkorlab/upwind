import { AsyncLocalStorage } from 'node:async_hooks';

import { kvGenerationKey } from '@stayingupwind/core/cache';
import {
  CACHE_ENTRY_HEADER,
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_ROUTE_HEADER,
  CACHE_UPGRADE_HEADER,
  MIDDLEWARE_ONLY_HEADER,
  pathFromHeaders,
  readMiddlewareResponse,
  REGENERATE_HEADER,
  type RegenerateMode,
} from '@stayingupwind/core/paas';
import { budgetPatterns, sanitizePassthroughHeaders } from '@stayingupwind/core/request';
import { toHex } from '@stayingupwind/core/util';
import { applyNonceToHeaders, rewriteDocumentNonces } from '@stayingupwind/edge/handlers/csp-nonce';
import { stateFromPointer } from '@stayingupwind/edge/preview/state';
import type { IncomingRequest } from '@stayingupwind/edge/request-context';
import { routeRequest, startReads } from '@stayingupwind/edge/route';
import {
  type StandaloneEnv,
  handleStandalone,
  standaloneHost,
  standaloneRuntime,
} from '@stayingupwind/edge/standalone';
import { cspNonceModeSchema, edgePointerSchema } from '@stayingupwind/host/delivery';
import { WorkerEntrypoint } from 'cloudflare:workers';

import { frontLineCf } from '../front-line-cf.ts';
import { GenerationEvidence, watchedGenerationMemory } from './generation-evidence.ts';
import {
  BACKSTAGE_ROUTES,
  FRONT_LINE_CODINGS,
  GATE_UNREACHABLE_HEADER,
  type MiddlewareProbe,
  NODE_URL_HEADER,
  NONCE_PARAMS,
  type NoncedPolicies,
  probeReason,
  type Regeneration,
  type StampedDigest,
  TRACE_HEADER,
  TRACE_KEEP_PARAM,
  type TraceRecord,
} from './protocol.ts';
import { watchedCacheSignals } from './watched-records.ts';

/**
 * The standalone edge, served on this machine: over plain HTTP, on a port of its own. The edge
 * addresses what it forwards to a Function as it is addressed deployed — HTTPS, on the default
 * port — so what reaches a Function here is given back the origin the visitor used, its scheme,
 * host and port, for what the application builds from it (a redirect, an absolute URL, an `Origin`
 * check) to name an address the visitor can reach.
 */

const FUNCTION_BINDING_PREFIX = 'APP__';
/** How the edge is bound to each of the routes' gates (`gateBinding`). */
const GATE_BINDING_PREFIX = 'GATE__';
/** How many traced requests are kept unread: a check reads each as soon as it needs it. */
const MAX_TRACES = 256;
/** The regeneration a request waits on, whose render is its answer. */
const FOREGROUND: RegenerateMode = 'foreground';
const NOTHING_KEPT: TraceRecord = { decision: null, regenerated: null };

/** What was kept of each traced request, by its id (`TRACE_HEADER`). */
const traces = new Map<string, TraceRecord>();
/** Only registered checks retain snapshots beyond what the edge's byte-budgeted cache holds. */
const generations = new GenerationEvidence(MAX_TRACES);
/** The request responsible for a memory hit or adoption, including its asynchronous work. */
const generationTrace = new AsyncLocalStorage<string>();
type LocalMemory = ReturnType<typeof standaloneRuntime>['memory'];
/** The same memory identity for every local request, including coalesced and background work. */
const observedMemories = new WeakMap<LocalMemory, LocalMemory>();
/**
 * The ids a check registered on the backstage, each good for one request, with the value of the
 * header's own the request goes on with, if any (`TRACE_KEEP_PARAM`): only a request carrying one
 * of them is traced. Any other `x-upwind-trace` is a visitor's own header, which the site serves as
 * it would deployed — untouched.
 */
const registered = new Map<string, string | null>();

/** The oldest unread trace let go of beyond its budget: a check reads each soon after it. */
function bound(kept: Map<string, unknown> | Set<string>): void {
  if (kept.size > MAX_TRACES) {
    const [oldest] = kept.keys();
    if (oldest !== undefined) {
      kept.delete(oldest);
    }
  }
}

function keep(trace: string, kept: Partial<TraceRecord>): void {
  const record = { ...(traces.get(trace) ?? NOTHING_KEPT), ...kept };
  traces.delete(trace);
  traces.set(trace, record);
  bound(traces);
}

/** An id the check is done with, read or not: nothing more of it to keep, nor a request to trace. */
function letGo(trace: string): void {
  registered.delete(trace);
  traces.delete(trace);
  generations.forget(trace);
}

function register(trace: string, own: string | null): void {
  registered.delete(trace);
  registered.set(trace, own);
  bound(registered);
}

interface FunctionService {
  fetch(request: Request): Promise<Response>;
}

function isFunctionService(value: unknown): value is FunctionService {
  return typeof value === 'object' && value !== null && 'fetch' in value;
}

/**
 * The origin a request came in under, as its visitor addressed it: the host it names, under the
 * scheme a front of the stack says it came over (`X-Forwarded-Proto`) — a check says HTTPS, as a
 * deployment's validation does — or the socket's own where none says.
 */
function originOf(request: Request): URL {
  const url = new URL(request.url);
  const said = request.headers.get('x-forwarded-proto')?.trim().toLowerCase();
  const scheme = said === 'http' || said === 'https' ? `${said}:` : url.protocol;
  return new URL(`${scheme}//${request.headers.get('host') ?? url.host}`);
}

/** The request as the edge reads it: under the origin its visitor addressed it to (`originOf`). */
function underOrigin(request: IncomingRequest, origin: URL): IncomingRequest {
  const url = new URL(request.url);
  if (url.origin === origin.origin) {
    return request;
  }
  url.protocol = origin.protocol;
  url.host = origin.host;
  url.port = origin.port;
  return new Request<unknown, IncomingRequestCfProperties>(url, request);
}

/** A request forwarded to the visitor's hostname, addressed to their origin. */
function addressed(
  origin: URL,
  forwarded: Request,
  originalCf: IncomingRequestCfProperties | undefined,
): Request {
  const url = new URL(forwarded.url);
  if (url.hostname !== origin.hostname) {
    return forwarded;
  }
  url.protocol = origin.protocol;
  url.host = origin.host;
  const headers = new Headers(forwarded.headers);
  headers.set('host', origin.host);
  headers.set('x-forwarded-host', origin.host);
  headers.set('x-forwarded-proto', origin.protocol.slice(0, -1));
  const cf = forwarded.cf ?? originalCf;
  return new Request(url, {
    method: forwarded.method,
    headers,
    body: forwarded.body,
    ...(cf !== undefined && { cf }),
    redirect: 'manual',
    // A visitor who goes away cancels the Function's work, as deployed.
    signal: forwarded.signal,
  });
}

/**
 * What the edge asks a Function to regenerate with `forwarded`, where it asks the Function to
 * regenerate a record in front of the request (`regenerationHeaders` in the edge).
 */
function regenerationOf(forwarded: Request): Regeneration | undefined {
  const { headers } = forwarded;
  if (headers.get(REGENERATE_HEADER) !== FOREGROUND) {
    return undefined;
  }
  return {
    entry: headers.get(CACHE_ENTRY_HEADER) ?? '',
    route: pathFromHeaders(headers, CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER) ?? '',
    member: headers.get(CACHE_UPGRADE_HEADER) === '1',
  };
}

/**
 * `service`, with what is forwarded to the visitor's hostname addressed to their origin — and, for
 * a traced request, what the edge did that its answer does not say kept for the check to read: the
 * middleware's answer, and the record it had the Function regenerate in front of the request.
 */
function servedFrom(
  origin: URL,
  service: FunctionService,
  trace: string | undefined,
  originalCf: IncomingRequestCfProperties | undefined,
): FunctionService {
  return {
    async fetch(forwarded) {
      const regenerated = trace === undefined ? undefined : regenerationOf(forwarded);
      if (trace !== undefined && regenerated !== undefined) {
        keep(trace, { regenerated });
      }
      const response = await service.fetch(addressed(origin, forwarded, originalCf));
      // The edge marks its own ask of the middleware (`x-arkor-middleware`, set on every such ask by
      // `middleware.ts` in the edge), which is how it is told from a request the edge forwards to a
      // Function to answer.
      if (trace !== undefined && forwarded.headers.get(MIDDLEWARE_ONLY_HEADER) === '1') {
        keep(trace, { decision: { status: response.status, headers: [...response.headers] } });
      }
      return response;
    },
  };
}

/**
 * `service`, a route's gate as the stack binds it (`../gates.ts`): handed what the edge asks it
 * addressed to the visitor's origin, as a Function is (`addressed`) — the URL said beside it for
 * Node, which the loopback there does not carry whole (`NODE_URL_HEADER`) — and failing as a
 * deployed edge's binding to a gate that cannot answer fails where the stack says the gate could
 * not be reached at all (`GATE_UNREACHABLE_HEADER`) — so the edge answers as it would deployed. It
 * is cancelled with what the edge asked, as the request it addresses is (`addressed`).
 */
function gateFrom(origin: URL, service: FunctionService): FunctionService {
  return {
    async fetch(asked) {
      const sent = addressed(origin, asked, undefined);
      const headers = new Headers(sent.headers);
      headers.set(NODE_URL_HEADER, sent.url);
      const answer = await service.fetch(new Request(sent, { headers, signal: sent.signal }));
      const unreachable = answer.headers.get(GATE_UNREACHABLE_HEADER);
      if (unreachable === null) {
        return answer;
      }
      await answer.body?.cancel();
      throw new Error(`the gate could not be reached: ${unreachable}`);
    },
  };
}

/** `kv`, whatever the edge reads of it looked at for a generation's headers on its way. */
function watched(kv: KVNamespace, trace: string): KVNamespace {
  return new Proxy(kv, {
    get(target, property): unknown {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') {
        return member;
      }
      if (property !== 'get') {
        return member.bind(target);
      }
      return async (key: string, ...rest: unknown[]): Promise<unknown> => {
        const value: unknown = await Reflect.apply(member, target, [key, ...rest]);
        generations.observe(trace, key, value);
        return value;
      };
    },
  });
}

/**
 * `env`, each Function in it reached as `servedFrom` reaches it, each gate as `gateFrom` reaches
 * it, and the runtime cache's records read as `watched` reads them, whether KV or the authority
 * answers with them. Both pass through the same decoder before the check is told the generation
 * was read.
 */
function servedEnv(
  env: StandaloneEnv,
  origin: URL,
  trace: string | undefined,
  originalCf: IncomingRequestCfProperties | undefined,
): StandaloneEnv {
  const local: StandaloneEnv = {
    ...env,
    CACHE_STATE: trace === undefined ? env.CACHE_STATE : watched(env.CACHE_STATE, trace),
    CACHE_SIGNALS:
      trace === undefined
        ? env.CACHE_SIGNALS
        : watchedCacheSignals(env.CACHE_SIGNALS, (key, value) => {
            generations.observe(trace, key, value);
          }),
  };
  for (const name of Object.keys(env)) {
    const service: unknown = Reflect.get(env, name);
    if (!isFunctionService(service)) {
      continue;
    }
    if (name.startsWith(FUNCTION_BINDING_PREFIX)) {
      Reflect.set(local, name, servedFrom(origin, service, trace, originalCf));
    } else if (name.startsWith(GATE_BINDING_PREFIX)) {
      Reflect.set(local, name, gateFrom(origin, service));
    }
  }
  return local;
}

/** Preserve isolate-wide control slots keyed by memory identity across traced and ordinary work. */
function localRuntime(env: StandaloneEnv): ReturnType<typeof standaloneRuntime> {
  const runtime = standaloneRuntime(env);
  let memory = observedMemories.get(runtime.memory);
  if (memory === undefined) {
    memory = {
      ...runtime.memory,
      generations: watchedGenerationMemory(runtime.memory.generations, (key, pack) => {
        generations.held(generationTrace.getStore(), key, pack);
      }),
    };
    observedMemories.set(runtime.memory, memory);
  }
  return { ...runtime, memory };
}

/** Capture ends at the response, even when the check never consumes or deletes its trace. */
async function serveTraced(
  request: IncomingRequest,
  env: StandaloneEnv,
  ctx: ExecutionContext,
  trace: string,
): Promise<Response> {
  try {
    return await generationTrace.run(trace, () => {
      const response = handleStandalone(request, env, ctx, localRuntime(env));
      return response;
    });
  } finally {
    generations.seal(trace);
  }
}

/** The pointer the edge serves, as it reads one: pinned on the Worker, or kept under `POINTER_KEY`. */
async function pointerOf(env: StandaloneEnv): Promise<unknown> {
  const json =
    env.POINTER ??
    (env.POINTER_KEY === undefined ? null : await env.EDGE_STATE.get(env.POINTER_KEY));
  try {
    return json === null ? undefined : (JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

const ACCEPT_ENCODING = 'accept-encoding';

/**
 * `headers` as Cloudflare's front line hands a Worker a request's: its `Accept-Encoding` the one it
 * sets on every request (`FRONT_LINE_CODINGS`), whatever the visitor sent.
 */
function frontLineHeaders(headers: Headers): Headers {
  const handed = new Headers(headers);
  handed.set(ACCEPT_ENCODING, FRONT_LINE_CODINGS);
  return handed;
}

/**
 * What the front line keeps of a request for a Worker to answer it by (`cf`): the visitor's own
 * `Accept-Encoding` (`cf.clientAcceptEncoding`), beside whatever else `cf` holds — none sent, none
 * accepted but the bytes themselves, as the front line hands such a visitor the answer undone.
 */
function clientCodingsOf(
  headers: Headers,
  cf: IncomingRequestCfProperties | undefined,
): IncomingRequestCfProperties {
  const clientAcceptEncoding = headers.get(ACCEPT_ENCODING) ?? '';
  return frontLineCf(cf, clientAcceptEncoding) as IncomingRequestCfProperties;
}

/**
 * `request` as Cloudflare's front line hands a Worker one (`frontLineHeaders`) — the visitor's own
 * `Accept-Encoding` kept in `cf.clientAcceptEncoding` (`clientCodingsOf`), which the edge answers
 * by: so that a rule of `next.config`, the middleware and a Function read the request as they read
 * it deployed, and the edge answers it in what the visitor accepts.
 */
function frontLineHanded(
  request: Request<unknown, IncomingRequestCfProperties>,
): Request<unknown, IncomingRequestCfProperties> {
  return new Request<unknown, IncomingRequestCfProperties>(request, {
    headers: frontLineHeaders(request.headers),
    cf: clientCodingsOf(request.headers, request.cf),
  });
}

/**
 * The request as the visitor sent it, the check's id taken off — or the value of the header's own
 * it was registered with put back in its place: the edge routes by what a visitor sends, and the id
 * is the stack's, not the application's.
 */
function untraced(
  request: Request<unknown, IncomingRequestCfProperties>,
  own: string | null,
): Request<unknown, IncomingRequestCfProperties> {
  const headers = new Headers(request.headers);
  if (own === null) {
    headers.delete(TRACE_HEADER);
  } else {
    headers.set(TRACE_HEADER, own);
  }
  return new Request<unknown, IncomingRequestCfProperties>(request, { headers });
}

/**
 * What was kept of a traced request, read once: a `TraceRecord` — kept from when the request came
 * in — or `404` for an id no request came in under, or one let go of since (`bound`).
 */
function keptAt(trace: string): Response {
  const record = traces.get(trace);
  if (record === undefined) {
    return new Response(null, { status: 404 });
  }
  traces.delete(trace);
  return Response.json({ ...record, generations: generations.snapshot(trace) });
}

/**
 * The headers a generation of a record was recorded with, as the edge read it; `null` for none —
 * or, asked of no sequence, every generation of the record the edge read, its headers and its
 * outputs, by sequence (`RecordedGeneration`).
 */
function generationAt(path: string, env: StandaloneEnv): Response {
  const [scopeId = '', entryId = '', seq] = path.split('/').map((part) => decodeURIComponent(part));
  const key = kvGenerationKey(scopeId, entryId);
  const read = generations.forRecord(standaloneRuntime(env).memory.generations.values(), key);
  return Response.json(seq === undefined ? read : (read[seq]?.headers ?? null));
}

/**
 * The stack's backstage (`./protocol.ts`), on a socket of this entrypoint's own, which serves no
 * site: an id registered before the request it traces (`PUT /trace/<id>`), what was kept of that
 * request read back once (`GET /trace/<id>`) or let go of unread (`DELETE /trace/<id>`), an app Function asked as validation asks it through
 * its edge (`GET /function/<name>?path=…`), and the headers a generation of a route's record was
 * recorded with (`GET /generation/<scope>/<entry>/<seq>`) — or every one the edge read of the record
 * (`GET /generation/<scope>/<entry>`).
 */
/** The bytes sent, with `nonce` stamped in them as the edge stamps a document it composes. */
async function stamped(request: Request, nonce: string): Promise<Response> {
  const document = new Response(request.body, { headers: { 'content-type': 'text/html' } });
  return new Response(await rewriteDocumentNonces(document, nonce).arrayBuffer());
}

/**
 * The digest and length of a document sent, with `nonce` stamped in it as the edge stamps one it
 * composes: read as it streams, and held nowhere whole, as a document is as long as its
 * application makes it.
 */
async function stampedDigest(request: Request, nonce: string): Promise<Response> {
  const document = new Response(request.body, { headers: { 'content-type': 'text/html' } });
  const digest = new crypto.DigestStream('SHA-256');
  const { body } = rewriteDocumentNonces(document, nonce);
  await (body === null ? digest.close() : body.pipeTo(digest));
  const sha256 = toHex(new Uint8Array(await digest.digest));
  const answer: StampedDigest = { sha256, length: Number(digest.bytesWritten) };
  return Response.json(answer);
}

/** Policies as sent: an object of strings, by the names of the headers they go out under. */
function isPolicies(sent: unknown): sent is NoncedPolicies {
  return (
    typeof sent === 'object' &&
    sent !== null &&
    Object.values(sent).every((value) => typeof value === 'string')
  );
}

/** The policies sent, with `nonce` put in them as the edge puts it under the setting asked for. */
async function nonced(request: Request, asked: URLSearchParams, nonce: string): Promise<Response> {
  const mode = cspNonceModeSchema.safeParse(asked.get(NONCE_PARAMS.mode));
  const sent: unknown = await request.json();
  if (!mode.success || !isPolicies(sent)) {
    return new Response('a nonce mode and policies are to be sent', { status: 400 });
  }
  const policies = new Headers(Object.entries(sent));
  applyNonceToHeaders(policies, nonce, mode.data, asked.get(NONCE_PARAMS.strict) === '1');
  return Response.json(Object.fromEntries(policies));
}

/** What the backstage makes of a nonce posted to it, by the route it is posted to. */
const NONCE_ANSWERS: ReadonlyMap<
  string,
  (request: Request, nonce: string, asked: URLSearchParams) => Promise<Response>
> = new Map([
  [
    BACKSTAGE_ROUTES.nonced,
    (request: Request, nonce: string, asked: URLSearchParams) => nonced(request, asked, nonce),
  ],
  [BACKSTAGE_ROUTES.stamp, (request: Request, nonce: string) => stamped(request, nonce)],
  [
    BACKSTAGE_ROUTES.stampedDigest,
    (request: Request, nonce: string) => stampedDigest(request, nonce),
  ],
]);

/**
 * What the edge makes of a nonce it minted (`BACKSTAGE_ROUTES.stamp`, `.stampedDigest`,
 * `.nonced`), if asked it.
 */
function nonceAnswer(url: URL, request: Request): Promise<Response> | undefined {
  const { pathname, searchParams } = url;
  const answering = NONCE_ANSWERS.get(pathname);
  if (answering === undefined) {
    return undefined;
  }
  const nonce = searchParams.get(NONCE_PARAMS.nonce);
  if (nonce === null || request.method !== 'POST') {
    return Promise.resolve(new Response('a nonce is to be posted', { status: 400 }));
  }
  return answering(request, nonce, searchParams);
}

export class Backstage extends WorkerEntrypoint<StandaloneEnv> {
  /**
   * The Function the build names `name`, asked for `pathname` as a deployment's validation asks
   * each: routed by the edge from the pointer it serves, as a signed validation's probe is routed
   * (`PreviewState.function`) — handed to that Function's Worker by the edge's own dispatch, told
   * the middleware ran, and answered as the edge answers, `x-arkor-edge` naming the Function it
   * asked where the build was split (`fn=`). Under the origin the check names (`originOf`: its
   * `Host`, over the scheme it says it came by), the Functions reached as the site's requests reach
   * them.
   */
  private async probe(name: string, pathname: string, request: IncomingRequest): Promise<Response> {
    const origin = originOf(request);
    const cf = clientCodingsOf(request.headers, request.cf);
    const env = servedEnv(this.env, origin, undefined, cf);
    const pointer = edgePointerSchema.safeParse(await pointerOf(env));
    if (!pointer.success) {
      return new Response('the edge serves no pointer to probe a Function by', { status: 503 });
    }
    // Every test of an application's routing pattern bounded, as for any request the edge routes.
    budgetPatterns();
    const runtime = localRuntime(env);
    const url = new URL(pathname, origin);
    const started = runtime.now();
    const reads = startReads({ env, ctx: this.ctx, runtime, pointer: pointer.data });
    const [stored, lookup] = await Promise.all([reads.manifestLookup, reads.policyLookup]);
    const state = stateFromPointer({
      runtime,
      pointer: pointer.data,
      stored,
      lookup,
      pathname: url.pathname,
      privateDelivery: false,
      cspReportingPath: undefined,
    });
    // Handed it as the front line hands a deployment's validation its probe (`frontLineHeaders`).
    const asked: IncomingRequest = new Request<unknown, IncomingRequestCfProperties>(url, {
      headers: frontLineHeaders(request.headers),
      redirect: 'manual',
      signal: request.signal,
      cf,
    });
    return routeRequest({
      request: asked,
      url,
      env,
      ctx: this.ctx,
      runtime,
      host: standaloneHost(env),
      state: { ...state, validated: true, function: name },
      timings: {
        pointerMs: undefined,
        manifestMs: runtime.now() - started,
        middlewareMs: undefined,
      },
    });
  }

  /**
   * The deployment's middleware, asked about `pathname` as the edge asks it (`runMiddleware`: its
   * own Worker, `x-arkor-middleware`) and past its matchers: so that one whose matchers cover
   * nothing the check asks for is still loaded and run once. What it made of the request, as the
   * edge reads it (`readMiddlewareResponse`), or that it failed.
   */
  private async middleware(pathname: string, request: IncomingRequest): Promise<Response> {
    const origin = originOf(request);
    const cf = clientCodingsOf(request.headers, request.cf);
    const env = servedEnv(this.env, origin, undefined, cf);
    const pointer = edgePointerSchema.safeParse(await pointerOf(env));
    const scriptName = pointer.success ? pointer.data.app?.middlewareScriptName : undefined;
    if (scriptName === undefined) {
      return new Response('the edge serves no middleware to ask', { status: 404 });
    }
    const url = new URL(pathname, origin);
    // As the front line hands the edge the request it asks about (`frontLineHeaders`).
    const handed = frontLineHeaders(request.headers);
    const headers = sanitizePassthroughHeaders(handed, {
      previewDomain: 'invalid',
      previewHost: origin.hostname,
      clientIp: handed.get('cf-connecting-ip') ?? undefined,
    });
    headers.set(MIDDLEWARE_ONLY_HEADER, '1');
    const dispatch = localRuntime(env).dispatchApp;
    let probe: MiddlewareProbe;
    try {
      const response =
        dispatch === undefined
          ? undefined
          : await dispatch(scriptName, new Request(url, { headers, redirect: 'manual' }));
      if (response === undefined) {
        probe = { kind: 'failed', reason: 'the edge has no way to its Functions' };
      } else {
        const { kind } = readMiddlewareResponse(response, url, handed);
        await response.body?.cancel();
        probe = { kind, status: response.status };
      }
    } catch (error) {
      // Cut to what the check reads of the account whole (Sentry): an error's message has no bound.
      const reason = error instanceof Error ? error.message : String(error);
      probe = { kind: 'failed', reason: probeReason(reason) };
    }
    return Response.json(probe);
  }

  override async fetch(request: IncomingRequest): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === BACKSTAGE_ROUTES.middleware) {
      return this.middleware(url.searchParams.get('path') ?? '/', request);
    }
    if (url.pathname.startsWith(BACKSTAGE_ROUTES.trace)) {
      const trace = decodeURIComponent(url.pathname.slice(BACKSTAGE_ROUTES.trace.length));
      if (request.method === 'DELETE') {
        letGo(trace);
        return new Response(null, { status: 204 });
      }
      if (request.method !== 'PUT') {
        return keptAt(trace);
      }
      register(trace, url.searchParams.get(TRACE_KEEP_PARAM));
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith(BACKSTAGE_ROUTES.function)) {
      const name = decodeURIComponent(url.pathname.slice(BACKSTAGE_ROUTES.function.length));
      return this.probe(name, url.searchParams.get('path') ?? '/', request);
    }
    if (url.pathname.startsWith(BACKSTAGE_ROUTES.generation)) {
      return generationAt(url.pathname.slice(BACKSTAGE_ROUTES.generation.length), this.env);
    }
    return nonceAnswer(url, request) ?? new Response(null, { status: 404 });
  }
}

export default {
  fetch(request, env, ctx): Promise<Response> {
    // A check's request says it came over HTTPS, as validation's does: the edge and every Function
    // then see it under that origin, as deployed; a browser's comes under the socket's own.
    const origin = originOf(request);
    const visited = underOrigin(request, origin);
    // Traced only under an id a check registered, and that once.
    const asked = visited.headers.get(TRACE_HEADER);
    const own = asked === null ? undefined : registered.get(asked);
    if (asked === null || own === undefined) {
      const handed = frontLineHanded(visited);
      const local = servedEnv(env, origin, undefined, handed.cf);
      return handleStandalone(handed, local, ctx, localRuntime(local));
    }
    registered.delete(asked);
    // Kept from now, so that a check reading it later is told it from an id never seen.
    keep(asked, {});
    const handed = frontLineHanded(untraced(visited, own));
    const local = servedEnv(env, origin, asked, handed.cf);
    generations.begin(asked);
    return serveTraced(handed, local, ctx, asked);
  },
} satisfies ExportedHandler<StandaloneEnv>;
