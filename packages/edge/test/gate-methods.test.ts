import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import {
  GATE_ACCEPT_HEADER,
  GATE_ANSWER_HEADER,
  GATE_CAPTURE,
  GATE_CAPTURE_HEADER,
  GATE_METHOD_HEADER,
  GATE_PASS,
  GATE_ROUTE_HEADER,
  GATE_SCOPE_DOCUMENTS,
  GATE_SCOPE_HEADER,
  GATE_SHELL,
  GATE_SHELL_CONTENT_TYPE,
} from '@stayingupwind/host/bindings';
import type { EdgePointer } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeGates, EdgeHost } from '../src/edge-host.ts';
import { GATE_TIMEOUT_MS } from '../src/handlers/gate.ts';
import { createEdgeMemory, type EdgeMemory } from '../src/memory/caches.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite, type SiteOptions } from './helpers/site.ts';

/**
 * A request of a gated route by a method other than `GET` and `HEAD` — a Server Action's `POST`, a
 * form's, an `OPTIONS` — asked of the route's gate before the Function sees it (`handlers/gate.ts`),
 * with a probe that carries none of its body (`handlers/gate-probe.ts`): handed on whole where the
 * gate passes it, answered with the gate's own answer where it says anything else, and answered 503
 * where the gate cannot say, or answers with a shell no such request is served.
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
const UNGATED: Omit<SiteOptions, 'document'> = {
  pathname: POST,
  dynamicRoutes: [{ sourceRegex: POST_PATTERN, route: POST }],
};
const KEPT_SINCE = 'Fri, 16 Oct 2026 00:00:00 GMT';
/** What a Function answers, as one whose answer every cache may keep. */
const PUBLIC = 'public, max-age=60';
/** A body that arrives in pieces, as a client uploads one, a binary piece among them. */
const PIECES: readonly Uint8Array[] = [
  encodeUtf8('first piece;'),
  new Uint8Array([0, 255, 1, 254, 13, 10]),
  encodeUtf8('last piece'),
];
/** What says something of a body or of a stored copy, which no probe carries. */
const BODY_AND_VALIDATORS: readonly string[] = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'if-range',
  'range',
];

/** What a gate was handed: the request as it read it, and whether it carried a body at all. */
interface Asked {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: boolean;
}

/** A host's gates, each answering as `answer` does, and what each was asked. */
function gatesAnswering(answer: (asked: Asked) => Response | Promise<Response>): {
  readonly gates: EdgeGates;
  readonly asked: Asked[];
} {
  const asked: Asked[] = [];
  return {
    asked,
    gates: {
      answer: async (_name, request): Promise<Response> => {
        const seen = {
          method: request.method,
          url: request.url,
          headers: new Headers(request.headers),
          body: request.body !== null,
        };
        asked.push(seen);
        return answer(seen);
      },
    },
  };
}

function passing(headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS, ...headers } });
}

function hostWith(gates: EdgeGates | undefined): EdgeHost {
  return { ...standaloneHost(env), gates };
}

/** What the deployment's Function was handed: each request's method, path and body, read whole. */
interface Dispatched {
  readonly method: string;
  readonly pathname: string;
  readonly body: Uint8Array;
}

interface Routing {
  readonly site?: Omit<SiteOptions, 'document'>;
  readonly settings?: Partial<EdgePointer>;
  /** The isolate's memory, shared by the requests a test routes one after another. */
  readonly memory?: EdgeMemory;
}

/**
 * `request` routed by `host` from the pointer of the site seeded as `site` says, its fields
 * overridden by `settings`: its answer, and what the Function was handed, which answers each with a
 * word of its own that every cache may keep.
 */
async function routed(
  request: IncomingRequest,
  host: EdgeHost,
  { site = GATED, settings = {}, memory = createEdgeMemory(() => Date.now()) }: Routing = {},
): Promise<{
  readonly response: Response;
  readonly body: string;
  readonly dispatched: Dispatched[];
}> {
  const { pointer } = await seedSite({ document: pprDocument(), ...site });
  const dispatched: Dispatched[] = [];
  const runtime = standaloneRuntime(env, {
    memory,
    dispatchApp: async (_: string, handed: Request): Promise<Response> => {
      dispatched.push({
        method: handed.method,
        pathname: new URL(handed.url).pathname,
        body: new Uint8Array(await handed.arrayBuffer()),
      });
      return new Response('from the Function', { headers: { 'cache-control': PUBLIC } });
    },
  });
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host,
    pointer: { ...pointer, ...settings },
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body, dispatched };
}

/** A body streamed in `PIECES`, never all at once. */
function streamed(): ReadableStream<Uint8Array> {
  const pieces = [...PIECES];
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      const piece = pieces.shift();
      if (piece === undefined) {
        controller.close();
      } else {
        controller.enqueue(piece);
      }
    },
  });
}

/** A browser's form sent to a post by `method`, its body streamed, as a navigation of the page. */
function sent(method: string): IncomingRequest {
  const init: RequestInit & { duplex: 'half' } = {
    method,
    body: streamed(),
    duplex: 'half',
    headers: { 'next-action': 'abc123' },
  };
  return navigation('/posts/abc?tab=open', init);
}

describe('a request of a gated route by another method', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * The gate is asked with a `GET` of the request's URL, told the method it stands for, the visitor's
   * own headers on it — but none that describe a body it does not carry or a stored copy, and no
   * offer of a shell, which no such request is served.
   */
  it('asks its gate with a GET of the same URL that names the method and carries none of the body', async () => {
    const { gates, asked } = gatesAnswering(() => new Response('revoked', { status: 403 }));
    const request = navigation('/posts/abc?tab=open', {
      method: 'POST',
      body: 'form',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '4',
        'content-encoding': 'identity',
        'content-language': 'en',
        'if-match': '"kept"',
        'if-none-match': '"kept"',
        'if-modified-since': KEPT_SINCE,
        'if-unmodified-since': KEPT_SINCE,
        'if-range': '"kept"',
        range: 'bytes=0-1',
        cookie: 'session=one',
        'next-action': 'abc123',
        // What a visitor says under the protocol's own names is never what its gate is told.
        [GATE_METHOD_HEADER]: 'GET',
      },
    });

    await routed(request, hostWith(gates));

    expect(
      asked.map((seen) => {
        return {
          method: seen.method,
          url: seen.url,
          body: seen.body,
          told: seen.headers.get(GATE_METHOD_HEADER),
          route: seen.headers.get(GATE_ROUTE_HEADER),
          shell: seen.headers.has(GATE_ACCEPT_HEADER),
        };
      }),
    ).toStrictEqual([
      {
        method: 'GET',
        url: 'https://site.example/posts/abc?tab=open',
        body: false,
        told: 'POST',
        route: POST,
        shell: false,
      },
    ]);

    const headers = asked[0]?.headers ?? new Headers();

    expect(
      ['cookie', 'next-action', 'sec-fetch-dest'].map((name) => headers.get(name)),
    ).toStrictEqual(['session=one', 'abc123', 'document']);
    expect(BODY_AND_VALIDATORS.filter((name) => headers.has(name))).toStrictEqual([]);
  });

  /** A `GET` asked as itself is told no method: the request it is handed says it. */
  it('tells its gate no method of a GET it is asked about as itself', async () => {
    const { gates, asked } = gatesAnswering(() => new Response('revoked', { status: 403 }));

    await routed(
      navigation('/posts/abc', { headers: { [GATE_METHOD_HEADER]: 'POST' } }),
      hostWith(gates),
    );

    expect(
      asked.map(({ method, headers }) => [method, headers.get(GATE_METHOD_HEADER)]),
    ).toStrictEqual([['GET', null]]);
  });

  /**
   * Where its gate passes the probe, the visitor's own request goes to the Function, its body as it
   * was sent — never read, copied or held for the gate — and its answer is kept from shared caches,
   * as an admitted read's is: the gate admitted this visitor alone.
   */
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'hands a %s its gate passes to the Function with its streamed body byte for byte',
    async (method) => {
      const { gates, asked } = gatesAnswering(() => passing());

      const { response, body, dispatched } = await routed(sent(method), hostWith(gates));

      expect(asked.map(({ headers }) => headers.get(GATE_METHOD_HEADER))).toStrictEqual([method]);
      expect(response.status).toBe(200);
      expect(body).toBe('from the Function');
      expect(response.headers.get('cache-control')).toBe('private, max-age=60');
      expect(dispatched.map((handed) => [handed.method, handed.pathname])).toStrictEqual([
        [method, '/posts/abc'],
      ]);
      expect(dispatched[0]?.body).toStrictEqual(concatBytes([...PIECES]));
    },
  );

  /** A capture is of a render a `GET` makes: asked beside a pass of a probe, it is the pass alone. */
  it('hands on a POST whose gate asks a capture beside its pass as it hands on any it passes', async () => {
    const { gates } = gatesAnswering(() => passing({ [GATE_CAPTURE_HEADER]: GATE_CAPTURE }));

    const { response, dispatched } = await routed(sent('POST'), hostWith(gates));

    expect(response.status).toBe(200);
    expect(dispatched.map((handed) => handed.method)).toStrictEqual(['POST']);
    expect(dispatched[0]?.body).toStrictEqual(concatBytes([...PIECES]));
  });

  /** Any other answer is the visitor's, as the gate gave it, kept nowhere; the Function is not asked. */
  it.each([
    ['a refusal', 403, null],
    ['a redirect to sign in', 302, 'https://site.example/login'],
  ])('answers the visitor with %s its gate answers', async (_, status, location) => {
    const { gates } = gatesAnswering(() => {
      return new Response(status === 403 ? 'revoked' : null, {
        status,
        headers: { 'x-said': 'no', ...(location !== null && { location }) },
      });
    });

    const { response, body, dispatched } = await routed(sent('POST'), hostWith(gates));

    expect(response.status).toBe(status);
    expect(body).toBe(status === 403 ? 'revoked' : '');
    expect(response.headers.get('location')).toBe(location);
    expect(response.headers.get('x-said')).toBe('no');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe(`gate;name=${GATE}`);
    expect(dispatched).toStrictEqual([]);
  });

  /** A shell is served as a navigation's document, which no request of another method is. */
  it('is answered that its gate is unavailable where the gate answers it with a shell', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const { gates } = gatesAnswering(() => {
      return new Response('a shell', {
        headers: { [GATE_ANSWER_HEADER]: GATE_SHELL, 'content-type': GATE_SHELL_CONTENT_TYPE },
      });
    });

    const { response, dispatched } = await routed(sent('POST'), hostWith(gates));

    expect(response.status).toBe(503);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-shell-unserved');
    expect(dispatched).toStrictEqual([]);
  });

  /** Never handed on as though there were no gate. */
  it.each([
    ['where the host binds no gate', undefined],
    [
      'where its gate fails',
      {
        answer: (): Promise<Response> => Promise.reject(new Error('the gate broke')),
      } satisfies EdgeGates,
    ],
  ])('is answered that its gate is unavailable %s', async (_, gates) => {
    vi.spyOn(console, 'warn').mockReturnValue();

    const { response, dispatched } = await routed(sent('POST'), hostWith(gates));

    expect(response.status).toBe(503);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-unavailable');
    expect(dispatched).toStrictEqual([]);
  });

  it('is answered that its gate is unavailable where its gate does not answer in time', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { promise: reached, resolve: reach } = Promise.withResolvers<undefined>();
    const gates: EdgeGates = {
      answer: async (): Promise<Response> => {
        reach(undefined);
        return new Promise<Response>(() => {
          // Never answers.
        });
      },
    };

    const answering = routed(sent('POST'), hostWith(gates));
    await reached;
    await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS);
    const { response, dispatched } = await answering;

    expect(response.status).toBe(503);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-unavailable');
    expect(dispatched).toStrictEqual([]);
  });

  /**
   * A gate that said it decides documents alone lets the route's other reads go on unasked; a request
   * of another method is none of those, and is asked about every time.
   */
  it('asks its gate about a POST whatever the gate said before of deciding documents alone', async () => {
    const { gates, asked } = gatesAnswering(() =>
      passing({ [GATE_SCOPE_HEADER]: GATE_SCOPE_DOCUMENTS }),
    );
    const host = hostWith(gates);
    const memory = createEdgeMemory(() => Date.now());

    await routed(navigation('/posts/abc'), host, { memory });
    const payload: IncomingRequest = new Request('https://site.example/posts/abc', {
      headers: { rsc: '1' },
    });
    await routed(payload, host, { memory });
    await routed(sent('POST'), host, { memory });
    await routed(sent('POST'), host, { memory });

    expect(asked.map(({ headers }) => headers.get(GATE_METHOD_HEADER))).toStrictEqual([
      null,
      'POST',
      'POST',
    ]);
  });

  /**
   * An `OPTIONS` reaches the route's Function as any other method does, so it is asked about as one:
   * its gate is told the method, and the preflight's own headers, to admit a preflight it allows.
   */
  it.each([
    ['refused', (): Response => new Response('revoked', { status: 403 }), 403, []],
    ['passed', (): Response => passing(), 200, ['OPTIONS']],
  ])(
    'asks its gate about a CORS preflight, and is %s as the gate says',
    async (_, answer, status, handed) => {
      const { gates, asked } = gatesAnswering(answer);
      const preflight: IncomingRequest = new Request('https://site.example/posts/abc', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://elsewhere.example',
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'content-type',
        },
      });

      const { response, dispatched } = await routed(preflight, hostWith(gates));

      expect(
        asked.map((seen) => [seen.method, seen.headers.get(GATE_METHOD_HEADER)]),
      ).toStrictEqual([['GET', 'OPTIONS']]);
      expect(asked[0]?.headers.get('origin')).toBe('https://elsewhere.example');
      expect(asked[0]?.headers.get('access-control-request-method')).toBe('PUT');
      expect(response.status).toBe(status);
      expect(dispatched.map((request) => request.method)).toStrictEqual(handed);
    },
  );

  /**
   * A pointer says its deployment is gated by either marker — the legacy `requiresGate` of version
   * one, or `hasGates` of version two — and either has the request wait for the manifest that says
   * which routes are.
   */
  it.each([
    ['the legacy requiresGate', { v: 1, requiresGate: true, hasGates: undefined }],
    ['hasGates', { v: 2, requiresGate: undefined, hasGates: true }],
    ['both', { v: 2, requiresGate: true, hasGates: true }],
  ] as const)('asks its gate about a POST of a pointer that says %s', async (_, settings) => {
    const { gates, asked } = gatesAnswering(() => new Response('revoked', { status: 403 }));

    const { response, dispatched } = await routed(sent('POST'), hostWith(gates), { settings });

    expect(asked).toHaveLength(1);
    expect(response.status).toBe(403);
    expect(dispatched).toStrictEqual([]);
  });
});

describe('a request of another method no gate is asked about', () => {
  /** A deployment that declares none never asks the host's gates anything, whatever the method. */
  it('hands a POST of a deployment that declares no gate to the Function with its body', async () => {
    const { gates, asked } = gatesAnswering(() => new Response('revoked', { status: 403 }));

    const { body, dispatched } = await routed(sent('POST'), hostWith(gates), {
      site: UNGATED,
    });

    expect(asked).toStrictEqual([]);
    expect(body).toBe('from the Function');
    expect(dispatched.map((handed) => [handed.method, handed.pathname])).toStrictEqual([
      ['POST', '/posts/abc'],
    ]);
    expect(dispatched[0]?.body).toStrictEqual(concatBytes([...PIECES]));
  });
});
