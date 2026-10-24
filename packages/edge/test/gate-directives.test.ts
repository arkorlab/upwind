import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  type DecodedGenerationPack,
  decodeGenerationPack,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import {
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_ROUTE_HEADER,
  CAPTURE_CONTENT_TYPE,
  CAPTURE_HEADER,
  FUNCTION_HEADER,
  MISDIRECTED_STATUS,
  RESUME_STATE_BODY,
  RESUME_STATE_HEADER,
  ROUTED_HEADER,
} from '@stayingupwind/core/paas';
import {
  EDGE_BYPASS_COOKIE,
  EDGE_DEBUG_HEADER,
  NEXT_RESUME_HEADER,
} from '@stayingupwind/core/request';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import {
  encodeGateShell,
  GATE_ACCEPT_HEADER,
  GATE_ANSWER_HEADER,
  GATE_CAPTURE,
  GATE_CAPTURE_HEADER,
  GATE_PASS,
  GATE_RESUME_HEADER,
  GATE_SCOPE_DOCUMENTS,
  GATE_SCOPE_HEADER,
  GATE_SHELL,
  GATE_SHELL_CONTENT_TYPE,
  type GateShellFields,
  MAX_GATE_SHELL_BYTES,
} from '@stayingupwind/host/bindings';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
  type DeliveryPolicy,
  type EdgePointer,
} from '@stayingupwind/host/delivery';
import { buildRecoveryHtml, RECOVERY_SCRIPT_CSP_SOURCE } from '@stayingupwind/host/splice';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeHost } from '../src/edge-host.ts';
import { createEdgeMemory, type EdgeMemory } from '../src/memory/caches.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import {
  type Document,
  htmlResponse,
  navigation,
  pprDocument,
  seedSite,
  type SiteOptions,
} from './helpers/site.ts';

/**
 * What a gate's answer directs the edge to do in its place (`handlers/gate.ts`): a capture its pass
 * asks for, handed to the route's Function told so, served from nothing the edge holds and kept by
 * nobody; and a shell of the gate's own, served as a generation of the route is — completed by the
 * route's Function from the state it carries — with nothing else read for it, or refused before
 * any byte where it is none. A pass that asks for neither serves as it always did: here, from the
 * route's record, which this isolate holds.
 */

const POST = '/posts/[slug]';
const POST_PATTERN = '^/posts/(?<slug>[^/]+?)(?:/)?$';
const GATE = 'checker';
const GATED: Omit<SiteOptions, 'document'> = {
  pathname: POST,
  dynamicRoutes: [{ sourceRegex: POST_PATTERN, route: POST, gated: POST }],
  gates: { [POST]: GATE },
  gatedPathnames: { [POST]: POST },
};
const NOW = 100;
/** A day, in ms: how far a host's clock may be set on as a gate is read. */
const DAY_MS = 86_400_000;
const KEY = { scopeId: 'scope-gated', entryId: 'entry-gated' };
const RECORD_HTML = '<html><body>the route’s record</body></html>';
const POLICY: DeliveryPolicy = {
  ...DEFAULT_DELIVERY_POLICY,
  runtimeCache: {
    ...DEFAULT_RUNTIME_CACHE_SETTINGS,
    generations: 'on',
    holdMs: 5000,
    cacheApiMaxAgeMs: 0,
  },
};
const STATUS = { ok: 200, unprocessable: 422, unavailable: 503, failed: 500 } as const;
const PRIVATE = 'private, no-store';

/** The head of the page a gate keeps for the route, one boundary left to its resume. */
const GATE_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/></head><body>' +
  '<main>the gate’s shell<!--$?--><template id="B:0"></template><p>Loading…</p><!--/$--></main>';
/** The state its resume reads: bytes no text decoder would leave as they are. */
const POSTPONED = Uint8Array.from([0, 1, 2, 0x7f, 0x80, 0xfe, 0xff]);
const TOKEN = 'resume-token.7';
const SHELL: GateShellFields = {
  status: STATUS.ok,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'x-robots-tag': 'noindex',
    'x-from-gate': 'kept',
  },
  route: POST,
  resume: TOKEN,
  seq: 7,
  id: 'shell-7',
};

/** What the Function answers a capture with: the render it made, as its own JSON. */
const CAPTURED = '{"captured":true}';
/** The deployment's Function, by its script, and a second one a split deployment runs beside it. */
const SCRIPT = 'site-app';
const SPLIT = { second: 'app-2', script: 'site-app-2' } as const;

/** A request the deployment's Function was handed: as it read it, its body read whole. */
interface Dispatched {
  /** The Worker it was handed to, by its script. */
  readonly script: string;
  readonly method: string;
  readonly pathname: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

/** What a request was answered, and what the edge read and asked for it. */
interface Served {
  readonly response: Response;
  readonly body: string;
  readonly dispatched: readonly Dispatched[];
  /** What the gate was handed of each request it was asked about. */
  readonly asked: readonly Headers[];
  /** Reads of the route's record, held or in storage, and of the build's shell or a rendering. */
  readonly recordReads: number;
  readonly shellReads: number;
  readonly document: Document;
}

interface Settings {
  /** How the Function answers a resume; with the page's suffix, unless said otherwise. */
  readonly resumed?: (document: Document) => Response;
  /** How the Worker `script` answers a capture; with the render, unless this says otherwise. */
  readonly captured?: (script: string) => Response | undefined;
  readonly pointer?: Partial<EdgePointer>;
  /** Read the body as the client undoes the coding it went out in, rather than as it is. */
  readonly decoded?: boolean;
  /**
   * The class as a build that made no shell of it has it — no route of its own in the manifest, its
   * dynamic route naming none — gated (`DynamicRoute.gated`) where `gated` says so.
   */
  readonly classless?: { readonly gated: boolean };
  /**
   * A page Next.js resolves exactly that the build made no shell of (`exactPathnames`), its own
   * route, the gate's too.
   */
  readonly exact?: string;
  /** The isolate's memory, where the request is served after others of the same isolate. */
  readonly memory?: EdgeMemory;
  /** How far the host's clock is set on once the gate is asked: not at all, unless said. */
  readonly clockSet?: number;
}

/** The route's own record: complete in itself, fresh, as the runtime cache wrote it. */
async function routeRecord(): Promise<{ readonly pack: DecodedGenerationPack; bytes: number }> {
  const html = encodeUtf8(RECORD_HTML);
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      ...KEY,
      generationId: 'gen_gated',
      seq: 1,
      revision: 3,
      source: 'runtime',
      kind: 'app-page',
      route: POST,
      pathname: POST,
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: STATUS.ok,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      tags: [],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    html,
    undefined,
  );
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('the record fixture did not decode');
  return { pack: decoded.pack, bytes: bytes.byteLength };
}

/**
 * The gated site's manifest as a build that made no shell of the class has it: no route of its own,
 * its dynamic route naming none — and the gate's, or none.
 */
function classlessManifest(manifest: ProjectManifest, gated: boolean): ProjectManifest {
  return {
    ...manifest,
    routes: {},
    dynamicRoutes: [{ sourceRegex: POST_PATTERN, ...(gated && { gated: POST }) }],
  };
}

/** `manifest` with a page Next.js resolves exactly that the build made no shell of, gated (`exact`). */
function exactManifest(manifest: ProjectManifest, exact: string): ProjectManifest {
  return {
    ...manifest,
    exactPathnames: { ...manifest.exactPathnames, [exact]: true },
    gates: { ...manifest.gates, [exact]: GATE },
    gatedPathnames: { ...manifest.gatedPathnames, [exact]: exact },
  };
}

/** The manifest the edge serves `site` by, as `settings` lay it out. */
function manifestOf(
  site: { readonly manifest: ProjectManifest },
  settings: Settings,
): ProjectManifest {
  const cached = cachedManifest(site.manifest);
  const classed =
    settings.classless === undefined ? cached : classlessManifest(cached, settings.classless.gated);
  return settings.exact === undefined ? classed : exactManifest(classed, settings.exact);
}

/** The gated site's manifest, its route an entry of the runtime cache's scope. */
function cachedManifest(manifest: ProjectManifest): ProjectManifest {
  const route = manifest.routes[POST];
  if (route === undefined) throw new Error('the site has no post route');
  return {
    ...manifest,
    cache: { keySchemaVersion: 1, scopeId: KEY.scopeId },
    routes: {
      [POST]: {
        ...route,
        cache: { entryId: KEY.entryId, kind: 'app-page', delivery: 'resume' },
      },
    },
  };
}

/**
 * The Function, as the Worker `script` of it: the page's suffix for a resume, its render for a
 * capture, a word of its own for anything else — each said to be kept by every cache, which the
 * edge is to overrule where nobody may keep it.
 */
function functionAnswer(
  handed: { readonly request: Request; readonly script: string },
  document: Document,
  settings: Settings,
): Response {
  const { request, script } = handed;
  if (request.headers.get(NEXT_RESUME_HEADER) === '1') {
    return settings.resumed?.(document) ?? htmlResponse(document.suffix);
  }
  const kept = { 'cache-control': 'public, max-age=60' };
  if (request.headers.get(CAPTURE_HEADER) !== '1') {
    return new Response('from the Function', { headers: kept });
  }
  const render = { 'content-type': CAPTURE_CONTENT_TYPE, ...kept };
  return settings.captured?.(script) ?? new Response(CAPTURED, { headers: render });
}

async function bodyOf(response: Response, decoded: boolean): Promise<string> {
  if (!decoded || response.body === null) return response.text();
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
}

/**
 * `request` of a gated post, routed by a host whose gate answers as `answer` does: the route's
 * record held in this isolate, the build's shell in storage, the Function answering as
 * `functionAnswer` does.
 */
async function served(
  request: IncomingRequest,
  answer: () => Response,
  settings: Settings = {},
): Promise<Served> {
  const document = pprDocument();
  const site = await seedSite({ document, ...GATED });
  const dispatched: Dispatched[] = [];
  const clock = { set: 0 };
  const runtime = standaloneRuntime(env, {
    now: () => NOW + clock.set,
    memory: settings.memory ?? createEdgeMemory(() => NOW),
    dispatchApp: async (script: string, handed: Request): Promise<Response> => {
      const body = new Uint8Array(await handed.arrayBuffer());
      const { method, url, headers } = handed;
      const pathname = new URL(url).pathname;
      dispatched.push({ script, method, pathname, headers: new Headers(headers), body });
      return functionAnswer({ request: handed, script }, document, settings);
    },
  });
  const record = await routeRecord();
  const held = { pack: record.pack, readAt: NOW, bytes: record.bytes };
  runtime.memory.generations.set(kvGenerationKey(KEY.scopeId, KEY.entryId), held, record.bytes);
  const reads = [
    vi.spyOn(runtime.memory.generations, 'get'),
    vi.spyOn(env.CACHE_STATE, 'get'),
    vi.spyOn(runtime.memory.shells, 'get'),
    vi.spyOn(env.EDGE_STATE, 'get'),
  ];
  const asked: Headers[] = [];
  const host: EdgeHost = {
    ...standaloneHost(env),
    gates: {
      answer: (_name, gateRequest): Promise<Response> => {
        clock.set = settings.clockSet ?? 0;
        asked.push(new Headers(gateRequest.headers));
        return Promise.resolve(answer());
      },
    },
  };
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime,
      host,
      pointer: { ...site.pointer, ...settings.pointer },
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: manifestOf(site, settings) }),
      policyLookup: Promise.resolve({ kind: 'found', source: 'exact', policy: POLICY }),
    },
  );
  const body = await bodyOf(response, settings.decoded === true);
  await waitOnExecutionContext(ctx);
  const [records = 0, recordsKept = 0, shells = 0, shellsKept = 0] = reads.map(
    (read) => read.mock.calls.length,
  );
  return {
    response,
    body,
    dispatched,
    asked,
    recordReads: records + recordsKept,
    shellReads: shells + shellsKept,
    document,
  };
}

/** A gate's answer that has the request served as though there were no gate. */
function passing(): Response {
  return new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS } });
}

/** A pass of a gate that decides a request that takes a shell alone, and says so. */
function documentsPassing(): Response {
  return new Response(null, {
    headers: { [GATE_ANSWER_HEADER]: GATE_PASS, [GATE_SCOPE_HEADER]: GATE_SCOPE_DOCUMENTS },
  });
}

/** A pass that asks for a capture of the request beside it. */
function capturing(): Response {
  return new Response(null, {
    headers: { [GATE_ANSWER_HEADER]: GATE_PASS, [GATE_CAPTURE_HEADER]: GATE_CAPTURE },
  });
}

/** A gate's answer of `bytes` as a shell. */
function shellAnswer(bytes: BodyInit, type = GATE_SHELL_CONTENT_TYPE): Response {
  return new Response(bytes, {
    headers: { [GATE_ANSWER_HEADER]: GATE_SHELL, 'content-type': type },
  });
}

/** A gate's shell of the route, its fields `SHELL`'s with `changes` over them. */
function gateShell(changes: Partial<GateShellFields> = {}): Response {
  return shellAnswer(encodeGateShell({ ...SHELL, ...changes }, encodeUtf8(GATE_HTML), POSTPONED));
}

/** A shell laid out by hand, as no encoder would lay one out. */
function laidOut(header: Readonly<Record<string, unknown>>, ...bodies: Uint8Array[]): Uint8Array {
  const headerBytes = encodeUtf8(JSON.stringify(header));
  const prefix = concatBytes([encodeUtf8('UPSH'), Uint8Array.of(1), new Uint8Array(4)]);
  new DataView(prefix.buffer).setUint32(5, headerBytes.byteLength, true);
  return concatBytes([prefix, headerBytes, ...bodies]);
}

/** The gate's shell of the route, laid out. */
function encoded(): Uint8Array {
  return encodeGateShell(SHELL, encodeUtf8(GATE_HTML), POSTPONED);
}

/** A `HEAD` of the post. */
function headRequest(): IncomingRequest {
  return navigation('/posts/abc', { method: 'HEAD' });
}

/** A `GET` of the post that says nothing of what it fetches, as a client that is no browser's. */
function unsaidRequest(): IncomingRequest {
  return new Request('https://site.example/posts/abc');
}

/** A `GET` of the post that says it is to be captured, as the authority's own for a shell. */
function capturedRequest(): IncomingRequest {
  return new Request('https://site.example/posts/abc', {
    headers: { [GATE_CAPTURE_HEADER]: GATE_CAPTURE },
  });
}

/** A prefetch of the post made with a resource's metadata, as Firefox makes a speculative one. */
function resourcePrefetch(): IncomingRequest {
  return navigation('/posts/abc', {
    headers: { purpose: 'prefetch', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'no-cors' },
  });
}

/** A request for the post's whole payload, as the client's router makes one. */
function payloadRequest(headers: Readonly<Record<string, string>> = {}): IncomingRequest {
  return new Request('https://site.example/posts/abc', { headers: { rsc: '1', ...headers } });
}

describe('a pass its gate asks nothing beside', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves the route as it always did: from its record, the Function asked nothing', async () => {
    const { response, body, dispatched, recordReads } = await served(
      navigation('/posts/abc'),
      passing,
    );

    expect(response.status).toBe(STATUS.ok);
    expect(body).toBe(RECORD_HTML);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toMatch(/;src=gen-memory;/u);
    expect(recordReads).toBeGreaterThan(0);
    expect(dispatched).toStrictEqual([]);
  });

  /** What a visitor sends under the protocol's names or the edge's own is no gate's word. */
  it('tells the Function of no capture a visitor asks for itself', async () => {
    const forged = {
      [GATE_ACCEPT_HEADER]: GATE_SHELL,
      [GATE_CAPTURE_HEADER]: GATE_CAPTURE,
      [CAPTURE_HEADER]: '1',
    };
    const { body, dispatched, asked } = await served(payloadRequest(forged), passing);

    expect(body).toBe('from the Function');
    expect(dispatched.map(({ headers }) => headers.has(CAPTURE_HEADER))).toStrictEqual([false]);
    expect(
      asked.map((headers) =>
        [GATE_ACCEPT_HEADER, GATE_CAPTURE_HEADER].map((name) => headers.has(name)),
      ),
    ).toStrictEqual([[false, false]]);
  });
});

describe('what the edge tells a gate of a request', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A shell is served a browser's navigation alone: the one request its gate is told takes one. */
  it('tells the gate a browser’s navigation takes a shell', async () => {
    const { asked } = await served(navigation('/posts/abc'), passing);

    expect(asked.map((headers) => headers.get(GATE_ACCEPT_HEADER))).toStrictEqual([GATE_SHELL]);
  });

  /** A shell is read whole: a gate that honors a range would answer a part of it. */
  it('asks the gate for a navigation’s shell whole, whatever range the browser asked for', async () => {
    const ranged = navigation('/posts/abc', {
      headers: { 'if-range': '"v1"', range: 'bytes=0-99' },
    });
    const { asked } = await served(ranged, passing);

    expect(asked.map((headers) => [headers.get('range'), headers.get('if-range')])).toStrictEqual([
      [null, null],
    ]);
  });

  it.each([
    ['a HEAD', headRequest],
    ['the router’s payload', () => payloadRequest()],
    ['a request that says nothing of itself', unsaidRequest],
    ['a prefetch made as a resource’s', resourcePrefetch],
  ])('tells the gate %s takes no shell', async (_name, request) => {
    const { asked } = await served(request(), passing);

    expect(asked.map((headers) => headers.has(GATE_ACCEPT_HEADER))).toStrictEqual([false]);
  });
});

describe('a gate that decides a request that takes a shell alone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * What the gate said of its route holds in the isolate: the route's requests that take no shell go
   * on unasked, as they would with no gate, and a navigation asks it still.
   */
  it('lets its route’s requests that take no shell go on unasked once it said so', async () => {
    const memory = createEdgeMemory(() => NOW);
    const first = await served(payloadRequest(), documentsPassing, { memory });
    const payload = await served(payloadRequest(), documentsPassing, { memory });
    const head = await served(headRequest(), documentsPassing, { memory });
    const unsaid = await served(unsaidRequest(), documentsPassing, { memory });
    const document = await served(navigation('/posts/abc'), documentsPassing, { memory });

    expect([first, payload, head, unsaid, document].map(({ asked }) => asked.length)).toStrictEqual(
      [1, 0, 0, 0, 1],
    );
    expect(payload.body).toBe('from the Function');
  });

  /** The authority's own request for a shell says so, for its gate alone lets it through as one. */
  it('asks it still of a request that says it is to be captured', async () => {
    const memory = createEdgeMemory(() => NOW);
    await served(payloadRequest(), documentsPassing, { memory });
    const { asked } = await served(capturedRequest(), documentsPassing, { memory });

    expect(asked).toHaveLength(1);
  });

  it('asks again of a route whose gate said nothing of what it decides', async () => {
    const memory = createEdgeMemory(() => NOW);
    await served(payloadRequest(), passing, { memory });
    const again = await served(payloadRequest(), passing, { memory });

    expect(again.asked).toHaveLength(1);
  });
});

describe('a capture its gate asks for beside a pass', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Handed to the route's Function at once, told it is a capture and the route it renders, and
   * answered with what the Function answers — never with the record the isolate holds, nor the
   * build's shell — kept by nobody, whatever the Function said of keeping it.
   */
  it('is the Function’s, told so, with nothing the edge holds read for it', async () => {
    const { response, body, dispatched, recordReads, shellReads } = await served(
      navigation('/posts/abc'),
      capturing,
    );
    const [handed] = dispatched;
    const told = [CAPTURE_HEADER, CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER];

    expect(body).toBe(CAPTURED);
    expect(response.headers.get('content-type')).toBe(CAPTURE_CONTENT_TYPE);
    expect(response.headers.get('cache-control')).toBe(PRIVATE);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('passthrough;reason=gate-capture');
    expect(dispatched.map(({ method, pathname }) => `${method} ${pathname}`)).toStrictEqual([
      'GET /posts/abc',
    ]);
    expect(told.map((name) => handed?.headers.get(name))).toStrictEqual(['1', POST, POST]);
    expect(recordReads + shellReads).toBe(0);
  });

  /** A render the Function cannot hand over is answered as the Function refuses it. */
  it('is answered as the Function refuses it, kept by nobody', async () => {
    const { response, body } = await served(navigation('/posts/abc'), capturing, {
      captured: () => {
        const kept = { 'cache-control': 'public, max-age=60' };
        return new Response('rendered dynamically', {
          status: STATUS.unprocessable,
          headers: kept,
        });
      },
    });

    expect(response.status).toBe(STATUS.unprocessable);
    expect(body).toBe('rendered dynamically');
    expect(response.headers.get('cache-control')).toBe(PRIVATE);
  });

  /**
   * One of a route another of a split deployment's Workers holds is sent on to that one by the
   * first, as any request is (`dispatchSplit`), told the same, and the routing it did beside it.
   */
  it('is sent on to the Worker whose route it is, told the same', async () => {
    const app = {
      deploymentId: 'dpl_site',
      scriptName: SCRIPT,
      functions: { [SPLIT.second]: SPLIT.script },
    };
    const misdirected = { [FUNCTION_HEADER]: SPLIT.second, [ROUTED_HEADER]: 'routed' };
    const { body, dispatched } = await served(navigation('/posts/abc'), capturing, {
      pointer: { app },
      captured: (script) => {
        return script === SCRIPT
          ? new Response(null, { status: MISDIRECTED_STATUS, headers: misdirected })
          : undefined;
      },
    });
    const told = (name: string): (string | null)[] =>
      dispatched.map(({ headers }) => headers.get(name));

    expect(body).toBe(CAPTURED);
    expect(dispatched.map(({ script }) => script)).toStrictEqual([SCRIPT, SPLIT.script]);
    expect(told(CAPTURE_HEADER)).toStrictEqual(['1', '1']);
    expect(told(CACHE_ROUTE_HEADER)).toStrictEqual([POST, POST]);
    expect(told(ROUTED_HEADER)).toStrictEqual([null, 'routed']);
  });

  /** A `HEAD` renders nothing to capture: it is served as the plain pass serves it. */
  it('is a plain pass for a HEAD', async () => {
    const captured = await served(headRequest(), capturing);
    const passed = await served(headRequest(), passing);

    expect(captured.response.status).toBe(passed.response.status);
    expect(captured.response.headers.get(EDGE_DEBUG_HEADER)).toBe(
      passed.response.headers.get(EDGE_DEBUG_HEADER),
    );
    expect(captured.response.headers.get(EDGE_DEBUG_HEADER)).toMatch(/;src=gen-memory;/u);
    expect(captured.dispatched).toStrictEqual([]);
    expect(captured.body).toBe('');
  });
});

describe('a shell its gate answers with', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The gate's bytes first, then the Function's resume of the state they carry, as the route the
   * shell names, with the gate's token beside it: no record, no shell of the build's and no
   * rendering read for it, the document one visitor's.
   */
  it('is completed by a resume of its state, its token beside it', async () => {
    const { response, body, dispatched, recordReads, shellReads, document } = await served(
      navigation('/posts/abc'),
      () => gateShell(),
    );
    const [resume] = dispatched;

    expect(body).toBe(GATE_HTML + document.suffixText);
    expect(`${resume?.method ?? ''} ${resume?.pathname ?? ''}`).toBe('POST /posts/abc');
    expect(resume?.body).toStrictEqual(POSTPONED);
    expect(
      [RESUME_STATE_HEADER, CACHE_ROUTE_HEADER, GATE_RESUME_HEADER].map((name) =>
        resume?.headers.get(name),
      ),
    ).toStrictEqual([RESUME_STATE_BODY, POST, TOKEN]);
    expect(dispatched).toHaveLength(1);
    expect(recordReads + shellReads).toBe(0);
    expect(response.headers.get('cache-control')).toMatch(/^private, no-store\b/u);
  });

  /**
   * A host's `fetch` undoes a coding it can of what a gate answers and keeps the header, as
   * workerd's does of gzip and br: a shell already undone is served as it is, never undone again.
   */
  it.each([['gzip'], ['br']])(
    'is served where the host’s fetch undid the gate’s %s, its header kept',
    async (coding) => {
      const { body, document } = await served(navigation('/posts/abc'), () => {
        return new Response(encoded(), {
          headers: {
            [GATE_ANSWER_HEADER]: GATE_SHELL,
            'content-encoding': coding,
            'content-type': GATE_SHELL_CONTENT_TYPE,
          },
        });
      });

      expect(body).toBe(GATE_HTML + document.suffixText);
    },
  );

  /**
   * A coding no host's `fetch` undoes reaches the edge as it was coded, which undoes none of a shell:
   * refused before a byte of it is asked for.
   */
  it.each([['deflate'], ['x-gzip'], ['gzip, br'], ['zstd']])(
    'answers 503 before any byte for a shell in %s, unread',
    async (coding) => {
      let pulled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled = true;
            controller.enqueue(encoded());
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const { response, dispatched } = await served(navigation('/posts/abc'), () => {
        return new Response(body, {
          headers: {
            [GATE_ANSWER_HEADER]: GATE_SHELL,
            'content-encoding': coding,
            'content-type': GATE_SHELL_CONTENT_TYPE,
          },
        });
      });

      expect(response.status).toBe(STATUS.unavailable);
      expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-shell-malformed');
      expect(dispatched).toStrictEqual([]);
      expect(pulled).toBe(false);
    },
  );

  /** One whose coding its host's fetch left on it is no shell the edge reads: never undone here. */
  it('answers 503 before any byte for a shell its host’s fetch left in gzip', async () => {
    const { response, dispatched } = await served(navigation('/posts/abc'), () => {
      const coded = new Blob([encoded()]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Response(coded, {
        headers: {
          [GATE_ANSWER_HEADER]: GATE_SHELL,
          'content-encoding': 'gzip',
          'content-type': GATE_SHELL_CONTENT_TYPE,
        },
      });
    });

    expect(response.status).toBe(STATUS.unavailable);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-shell-malformed');
    expect(dispatched).toStrictEqual([]);
  });

  /** Its headers replayed as a generation's are: those a shell goes out with, and no others. */
  it('goes out as a generation of the route, with the gate’s headers, named the gate’s', async () => {
    const { response } = await served(navigation('/posts/abc'), () => gateShell());
    const debug = response.headers.get(EDGE_DEBUG_HEADER) ?? '';

    expect(response.status).toBe(STATUS.ok);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.has('x-from-gate')).toBe(false);
    expect(debug).toMatch(/^shell;strategy=[^;]+;src=gen-gate;/u);
    expect(debug).toMatch(
      /;cont=resume;mw=miss;route=\/posts\/\[slug\];cache=unknown;seq=7;gate=checker$/u,
    );
  });

  /** The time a gate is given passes as it does, whatever the host's clock is set to meanwhile. */
  it('is served though the host’s clock is set on a day as it is read', async () => {
    const { response, body, document } = await served(navigation('/posts/abc'), () => gateShell(), {
      clockSet: DAY_MS,
    });

    expect(response.status).toBe(STATUS.ok);
    expect(body).toBe(GATE_HTML + document.suffixText);
  });

  it('tells the resume no token where the gate handed none', async () => {
    const { dispatched } = await served(navigation('/posts/abc'), () =>
      gateShell({ resume: undefined }),
    );

    expect(dispatched.map(({ headers }) => headers.has(GATE_RESUME_HEADER))).toStrictEqual([false]);
  });

  /** A resume that fails is recovered from as a record's is, the policy permitting the script. */
  it('is recovered where its resume fails, its policy permitting the recovery', async () => {
    const policy = "script-src 'self'";
    const { response, body } = await served(
      navigation('/posts/abc'),
      () => gateShell({ headers: { ...SHELL.headers, 'content-security-policy': policy } }),
      { resumed: () => new Response('down', { status: STATUS.failed }) },
    );

    expect(response.status).toBe(STATUS.ok);
    expect(body).toBe(GATE_HTML + buildRecoveryHtml());
    expect(response.headers.get('content-security-policy')).toContain(RECOVERY_SCRIPT_CSP_SOURCE);
  });

  it('goes out in the coding the client takes, compressed on the way', async () => {
    const request = navigation('/posts/abc', { headers: { 'accept-encoding': 'gzip' } });
    const { response, body, document } = await served(request, () => gateShell(), {
      decoded: true,
    });

    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toContain(';enc=gzip-live;');
    expect(body).toBe(GATE_HTML + document.suffixText);
  });

  /**
   * Whatever entry it is served under: a class the build made no shell of has none of the runtime
   * cache's, and the shell is every visitor's all the same.
   */
  it.each([
    ['of a class the build made a shell of', {}],
    ['of a class the build made no shell of', { classless: { gated: true } }],
  ] as const)('is given a nonce of its own response %s', async (_of, settings) => {
    const kept = 'a2VwdCBieSB0aGUgZ2F0ZQ==';
    const html = `${GATE_HTML}<script nonce="${kept}">1</script>`;
    const headers = { ...SHELL.headers, 'content-security-policy': `script-src 'nonce-${kept}'` };
    const { response, body } = await served(
      navigation('/posts/abc'),
      () => shellAnswer(encodeGateShell({ ...SHELL, headers }, encodeUtf8(html), POSTPONED)),
      { ...settings, pointer: { cspNonce: true, cspNonceMode: 'enforce' } },
    );
    const minted = /'nonce-([^']+)'/u.exec(response.headers.get('content-security-policy') ?? '');

    expect(minted?.[1]).toBeDefined();
    expect(minted?.[1]).not.toBe(kept);
    expect(body).toContain(`<script nonce="${minted?.[1] ?? ''}">1</script>`);
  });

  /**
   * A gated class the build made no shell of — a page that blocks on its params, say — is served the
   * gate's shell all the same: the shell is the gate's, and no build's is read for it.
   */
  it('is served for a gated class the build made no shell of', async () => {
    const { response, body, dispatched, recordReads, shellReads, document } = await served(
      navigation('/posts/abc'),
      () => gateShell(),
      { classless: { gated: true } },
    );

    const debug = response.headers.get(EDGE_DEBUG_HEADER) ?? '';

    expect(body).toBe(GATE_HTML + document.suffixText);
    expect(debug).toContain(';src=gen-gate;');
    expect(debug).toContain(';route=/posts/[slug];');
    expect(debug.endsWith(';gate=checker')).toBe(true);
    expect(dispatched.map(({ headers }) => headers.get(GATE_RESUME_HEADER))).toStrictEqual([TOKEN]);
    expect(recordReads + shellReads).toBe(0);
  });

  /** Of a class no gate is declared for, a shell is no document the edge composes: a pass. */
  it('is routed as a pass for a class the build made no shell of and no gate is of', async () => {
    const { response, body } = await served(navigation('/posts/abc'), () => gateShell(), {
      classless: { gated: false },
    });

    expect(body).toBe('from the Function');
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('passthrough;reason=route-not-proved');
  });

  /**
   * A page Next.js resolves exactly that the build made no shell of is served the gate's shell as
   * its own route — ahead of a gated class its pattern matches too, as Next.js resolves it.
   */
  it.each([
    ['of no class', '/about'],
    ['whose pattern a gated class’s matches', '/posts/new'],
  ])('is served for a page Next.js resolves exactly %s', async (_of, exact) => {
    const { response, body, dispatched, recordReads, shellReads, document } = await served(
      navigation(exact),
      () => gateShell({ route: exact }),
      { classless: { gated: true }, exact },
    );

    const debug = response.headers.get(EDGE_DEBUG_HEADER) ?? '';

    expect(body).toBe(GATE_HTML + document.suffixText);
    expect(debug).toContain(';src=gen-gate;');
    expect(debug).toContain(`;route=${exact};`);
    expect(dispatched.map(({ headers }) => headers.get(GATE_RESUME_HEADER))).toStrictEqual([TOKEN]);
    expect(recordReads + shellReads).toBe(0);
  });

  /**
   * A request the edge composes no document for — here one its recovery bypasses it for — is routed
   * as a pass would be, the Function rendering the document whole.
   */
  it('is routed as a pass where the edge composes no document for the request', async () => {
    const request = navigation('/posts/abc', { headers: { cookie: `${EDGE_BYPASS_COOKIE}=1` } });
    const { response, body, dispatched } = await served(request, () => gateShell());

    expect(body).toBe('from the Function');
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('passthrough;reason=bypass-cookie');
    expect(dispatched.map(({ headers }) => headers.has(GATE_RESUME_HEADER))).toStrictEqual([false]);
  });
});

describe('a shell its gate answers with that the edge does not serve', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['no magic', encoded().with(0, 0x58)],
    ['a version it does not read', encoded().with(4, 2)],
    ['a header that is not JSON', encoded().with(9, 0x78)],
    ['a header missing a field', laidOut({ status: 200 }, encodeUtf8(GATE_HTML), POSTPONED)],
    ['bodies that do not add up', concatBytes([encoded(), Uint8Array.of(0)])],
    [
      'no postponed state',
      laidOut(
        { ...SHELL, htmlLength: encodeUtf8(GATE_HTML).byteLength, postponedLength: 0 },
        encodeUtf8(GATE_HTML),
      ),
    ],
    ['more bytes than a shell may take', new Uint8Array(MAX_GATE_SHELL_BYTES + 1)],
  ])('answers 503 before any byte for %s', async (_, bytes) => {
    const { response, dispatched } = await served(navigation('/posts/abc'), () =>
      shellAnswer(bytes),
    );

    expect(response.status).toBe(STATUS.unavailable);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-shell-malformed');
    expect(response.headers.get('cache-control')).toBe(PRIVATE);
    expect(dispatched).toStrictEqual([]);
  });

  it('answers 503 for a shell of another type', async () => {
    const { response } = await served(navigation('/posts/abc'), () =>
      shellAnswer(encoded(), 'text/html'),
    );

    expect(response.status).toBe(STATUS.unavailable);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-shell-malformed');
  });

  it('answers that the gate is unavailable where the shell’s bytes stop coming', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded().subarray(0, 12));
        controller.error(new Error('the gate went away'));
      },
    });
    const { response, dispatched } = await served(navigation('/posts/abc'), () =>
      shellAnswer(broken),
    );

    expect(response.status).toBe(STATUS.unavailable);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-unavailable');
    expect(dispatched).toStrictEqual([]);
  });

  it.each([
    ['a HEAD', navigation('/posts/abc', { method: 'HEAD' })],
    ['a router’s request for the payload', payloadRequest()],
    ['a GET that says it is no navigation', unsaidRequest()],
  ])('answers 503 for a shell of %s, which no shell answers', async (_, request) => {
    const { response, dispatched } = await served(request, () => gateShell());

    expect(response.status).toBe(STATUS.unavailable);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-shell-unserved');
    expect(dispatched).toStrictEqual([]);
  });

  it('answers 503 for a shell of another route than its gate’s', async () => {
    const { response, dispatched } = await served(navigation('/posts/abc'), () =>
      gateShell({ route: '/other/[id]' }),
    );

    expect(response.status).toBe(STATUS.unavailable);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-shell-malformed');
    expect(dispatched).toStrictEqual([]);
  });

  it('answers 503 for a shell whose render answered other than 200', async () => {
    const { response, dispatched } = await served(navigation('/posts/abc'), () =>
      gateShell({ status: 404 }),
    );

    expect(response.status).toBe(STATUS.unavailable);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-shell-unserved');
    expect(dispatched).toStrictEqual([]);
  });
});
