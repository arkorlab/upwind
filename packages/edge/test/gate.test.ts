import type { ImagesConfig } from '@stayingupwind/core/images';
import type { HeaderRule } from '@stayingupwind/core/manifest';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import {
  GATE_ANSWER_HEADER,
  GATE_DEPLOYMENT_HEADER,
  GATE_PASS,
  GATE_ROUTE_HEADER,
  GATE_URL_HEADER,
} from '@stayingupwind/host/bindings';
import { DEFAULT_DELIVERY_POLICY, type EdgePointer } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeGates, EdgeHost } from '../src/edge-host.ts';
import { GATE_TIMEOUT_MS } from '../src/handlers/gate.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { manifestStateFromPointer } from '../src/preview/state.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { routeRequest, serveFromPointer } from '../src/route.ts';
import {
  gateBinding,
  handleStandalone,
  type StandaloneEnv,
  standaloneHost,
  standaloneRuntime,
} from '../src/standalone/index.ts';
import {
  htmlResponse,
  KEPT_DEPLOYMENT,
  navigation,
  pprDocument,
  seedSite,
  type SiteOptions,
} from './helpers/site.ts';

/**
 * A route the build declared a gate for, asked of its gate before the edge decides anything else of
 * a request of it (`handlers/gate.ts`): served as though there were no gate where the gate says to
 * go on, answered with the gate's own answer where it says anything else — kept nowhere — and
 * answered 503 where the gate cannot say.
 */

/** A class of pages with a shell, whose every member is its gate's to answer first. */
const POST = '/posts/[slug]';
const POST_PATTERN = '^/posts/(?<slug>[^/]+?)(?:/)?$';
const GATE = 'checker';
const GATED: Omit<SiteOptions, 'document'> = {
  pathname: POST,
  dynamicRoutes: [{ sourceRegex: POST_PATTERN, route: POST, gated: POST }],
  gates: { [POST]: GATE },
  gatedPathnames: { [POST]: POST },
};
/** The same site with no gate declared: what every request is served without one. */
const UNGATED: Omit<SiteOptions, 'document'> = {
  pathname: POST,
  dynamicRoutes: [{ sourceRegex: POST_PATTERN, route: POST }],
};
/** Two repetitions that take what the other does: quadratic in the length of what fails them. */
const QUADRATIC = String.raw`^/(?<slug>\w+\w+)!$`;
/** Long enough that the pattern's cost against it is past what a test is allowed. */
const CRAFTED = `/${'a'.repeat(4096)}`;
/** As long, past what a test is allowed, and within what the optimizer takes as a source. */
const CRAFTED_SOURCE = `/${'a'.repeat(2048)}`;
/** A cookie a host keeps as its own credential, which no gate is handed. */
const HOST_SESSION = 'host_session';

/** What a gate was handed: the request, as it read it, and what it was asked under. */
interface Asked {
  readonly name: string;
  readonly route: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
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
      answer: async (name, request, route): Promise<Response> => {
        const seen = {
          name,
          route,
          method: request.method,
          url: request.url,
          headers: new Headers(request.headers),
        };
        asked.push(seen);
        return answer(seen);
      },
    },
  };
}

/** A gate's answer that has the request served as though there were no gate. */
function passing(): Response {
  return new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS } });
}

/** A navigation to a post that names a deployment of its own, as the protocol would. */
function forgedDeployment(): IncomingRequest {
  return navigation('/posts/abc', { headers: { [GATE_DEPLOYMENT_HEADER]: 'dpl_forged' } });
}

/** The standalone host, its gates `gates`, or none. */
function hostWith(gates: EdgeGates | undefined): EdgeHost {
  return { ...standaloneHost(env), gates };
}

/**
 * `request` routed by a host of its own, the site seeded as `site` says: its answer, and the
 * pathname of each request the deployment's Function was handed, which answers a resume with the
 * page's suffix and anything else with a word of its own.
 */
async function routed(
  request: IncomingRequest,
  site: Omit<SiteOptions, 'document'>,
  host: EdgeHost,
  settings: Partial<EdgePointer> = {},
): Promise<{
  readonly response: Response;
  readonly body: string;
  readonly functionAsked: string[];
}> {
  const document = pprDocument();
  const { pointer } = await seedSite({ document, ...site });
  const functionAsked: string[] = [];
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (_: string, dispatched: Request): Promise<Response> => {
      functionAsked.push(new URL(dispatched.url).pathname);
      return Promise.resolve(
        dispatched.method === 'GET' && request.headers.get('rsc') === null
          ? htmlResponse(document.suffix)
          : new Response('from the Function'),
      );
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
  return { response, body, functionAsked };
}

/** A router's request for a member's whole payload, which goes straight to the Function. */
function payloadRequest(): IncomingRequest {
  return new Request('https://site.example/posts/abc', { headers: { rsc: '1' } });
}

/** A router's prefetch of part of a member. */
function prefetch(): IncomingRequest {
  return new Request('https://site.example/posts/abc', {
    headers: { rsc: '1', 'next-router-segment-prefetch': '/_tree' },
  });
}

describe('a route the build declared a gate for', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A gate that says to go on changes nothing of what the request is served. */
  it('is served as though there were no gate where its gate says to go on', async () => {
    const { gates, asked } = gatesAnswering(() => passing());

    const gated = await routed(navigation('/posts/abc'), GATED, hostWith(gates));
    const ungated = await routed(navigation('/posts/abc'), UNGATED, hostWith(undefined));

    expect(asked.map(({ name, route }) => ({ name, route }))).toStrictEqual([
      { name: GATE, route: POST },
    ]);
    expect(gated.response.status).toBe(200);
    expect(gated.response.headers.get(EDGE_DEBUG_HEADER)).toMatch(/^shell;/u);
    expect(gated.body).toBe(ungated.body);
  });

  /**
   * The gate is handed the visitor's request as the Function would be: the visitor's method, URL
   * and headers, the host's own credentials taken off, told the route it is of — and nothing the
   * visitor sent under the protocol's own names, which a gate could take for its host's word.
   */
  it('tells its gate the deployment the request is of, as its manifest names it — never one a visitor names — and none where it names none', async () => {
    const { gates, asked } = gatesAnswering(() => passing());

    await routed(forgedDeployment(), { ...GATED, dplId: 'dpl_served' }, hostWith(gates));
    await routed(forgedDeployment(), GATED, hostWith(gates));

    expect(asked.map(({ headers }) => headers.get(GATE_DEPLOYMENT_HEADER))).toStrictEqual([
      'dpl_served',
      null,
    ]);
  });

  it('hands its gate the visitor’s request, told the route it is of', async () => {
    const { gates, asked } = gatesAnswering(() => passing());
    const host = { ...hostWith(gates), credentials: { cookies: [HOST_SESSION], headers: [] } };
    const request = navigation('/posts/abc?tab=open', {
      headers: {
        cookie: `${HOST_SESSION}=signed-in; theme=dark`,
        [GATE_URL_HEADER]: 'https://elsewhere.example/posts/other',
        [GATE_ROUTE_HEADER]: '/forged',
      },
    });

    await routed(request, GATED, host);

    const [seen] = asked;

    expect(seen?.method).toBe('GET');
    expect(seen?.url).toBe('https://site.example/posts/abc?tab=open');
    expect(seen?.headers.get(GATE_ROUTE_HEADER)).toBe(POST);
    expect(seen?.headers.get('cookie')).toBe('theme=dark');
    expect(seen?.headers.get('sec-fetch-dest')).toBe('document');
    expect(seen?.headers.has(GATE_URL_HEADER)).toBe(false);
  });

  /**
   * Any other answer is the visitor's, as the gate gave it, finished as a Function's answer the edge
   * hands on is: kept by no cache between, `private, no-store` where the gate said nothing of it.
   * The Function is not asked.
   */
  it('is answered with what its gate answers otherwise', async () => {
    const { gates } = gatesAnswering(() => {
      return new Response('revoked', {
        status: 403,
        headers: { 'x-said': 'no', [GATE_ANSWER_HEADER]: 'refused' },
      });
    });

    const { response, body, functionAsked } = await routed(
      navigation('/posts/abc'),
      GATED,
      hostWith(gates),
    );

    expect(response.status).toBe(403);
    expect(body).toBe('revoked');
    expect(response.headers.get('x-said')).toBe('no');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.has(GATE_ANSWER_HEADER)).toBe(false);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe(`gate;name=${GATE}`);
    expect(functionAsked).toStrictEqual([]);
  });

  it.each(['GET', 'HEAD'])(
    'strips every reserved gate response header from a terminal %s answer',
    async (method) => {
      const { gates } = gatesAnswering(() => {
        return new Response('revoked', {
          status: 403,
          headers: {
            [GATE_ANSWER_HEADER]: 'refused',
            [GATE_ROUTE_HEADER]: POST,
            [GATE_DEPLOYMENT_HEADER]: 'dpl_internal',
            [GATE_URL_HEADER]: 'https://internal.example/gate',
            'X-Upwind-Gate-Extra': 'internal',
            'x-app-gate': 'ordinary',
            'x-said': 'no',
            'set-cookie': 'gate=1; Path=/',
          },
        });
      });
      const { response } = await routed(
        new Request('https://site.example/posts/abc', { method }),
        GATED,
        hostWith(gates),
      );

      expect([...response.headers.keys()]).not.toContainEqual(
        expect.stringMatching(/^x-upwind-gate-/u),
      );
      expect(response.headers.get('x-app-gate')).toBe('ordinary');
      expect(response.headers.get('x-said')).toBe('no');
      expect(response.headers.getSetCookie()).toStrictEqual(['gate=1; Path=/']);
      expect(response.status).toBe(403);
    },
  );

  /** And where it said how its answer may be kept, by the browser alone. */
  it('keeps its gate’s answer from every cache between', async () => {
    const { gates } = gatesAnswering(() => {
      return new Response('gone', {
        status: 404,
        headers: { 'cache-control': 'public, max-age=60, s-maxage=600' },
      });
    });

    const { response } = await routed(navigation('/posts/abc'), GATED, hostWith(gates));

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, max-age=60');
  });

  /**
   * Nothing of an answer is kept: the next request is its gate's to answer again, and once the gate
   * refuses the route, the very next request is refused — and served again once it lets it through.
   */
  it('asks its gate again for every request, whatever it answered before', async () => {
    const answers = [passing, () => new Response('revoked', { status: 403 }), passing];
    const { gates, asked } = gatesAnswering(() => (answers[asked.length - 1] ?? passing)());
    const host = hostWith(gates);

    const first = await routed(navigation('/posts/abc'), GATED, host);
    const second = await routed(navigation('/posts/abc'), GATED, host);
    const third = await routed(navigation('/posts/abc'), GATED, host);

    expect(asked).toHaveLength(3);
    expect([first.response.status, second.response.status, third.response.status]).toStrictEqual([
      200, 403, 200,
    ]);
    expect(second.body).toBe('revoked');
  });

  /** A `HEAD` is asked of the gate as itself, and answered as a `GET` would be, with no body. */
  it('asks its gate about a HEAD as the HEAD it is', async () => {
    const { gates, asked } = gatesAnswering(({ method }) =>
      method === 'HEAD' ? new Response(null, { status: 410 }) : passing(),
    );

    const { response, body } = await routed(
      navigation('/posts/abc', { method: 'HEAD' }),
      GATED,
      hostWith(gates),
    );

    expect(asked.map(({ method }) => method)).toStrictEqual(['HEAD']);
    expect(response.status).toBe(410);
    expect(body).toBe('');
  });

  /** The router's requests are the route's too: its payload, and a prefetch of a part. */
  it.each([
    ['a router’s request for the payload', payloadRequest()],
    ['a router’s prefetch of a part', prefetch()],
  ])('asks its gate about %s before anything else', async (_, request) => {
    const { gates, asked } = gatesAnswering(() => new Response('revoked', { status: 403 }));

    const { response, functionAsked } = await routed(request, GATED, hostWith(gates));

    expect(asked.map(({ route }) => route)).toStrictEqual([POST]);
    expect(response.status).toBe(403);
    expect(functionAsked).toStrictEqual([]);
  });

  /** And once its gate lets a payload through, it goes to the Function as it always did. */
  it('hands a router’s request its gate lets through to the Function', async () => {
    const { gates } = gatesAnswering(() => passing());

    const { body, functionAsked } = await routed(payloadRequest(), GATED, hostWith(gates));

    expect(body).toBe('from the Function');
    expect(functionAsked).toStrictEqual(['/posts/abc']);
  });
});

/** A nonce a page was rendered with once, as it is kept for every visitor. */
const KEPT_NONCE = 'a2VwdCBmb3IgZXZlcnlvbmU=';
/** The validators a gate names the page it keeps by. */
const ARTIFACT_TAG = '"artifact-1"';
const KEPT_SINCE = 'Fri, 16 Oct 2026 00:00:00 GMT';
const HTML = { 'content-type': 'text/html; charset=utf-8' } as const;
const CSP = 'content-security-policy';
const REPORT_ONLY = 'content-security-policy-report-only';

/** The page a gate keeps for every visitor: rendered once, its scripts given that render's nonce. */
function keptPage(policies: Readonly<Record<string, string>>, type = 'text/html; charset=utf-8') {
  const page = `<html><head><script nonce="${KEPT_NONCE}">1</script><script src="/a.js"></script></head></html>`;
  return new Response(page, { headers: { 'content-type': type, ...policies } });
}

/** The nonce a policy names: `Headers#get` answers `null` for a policy the answer has none of. */
function policyNonce(policy: string | null): string | undefined {
  return policy === null ? undefined : /'nonce-([^']+)'/u.exec(policy)?.[1];
}

function bodyNonces(body: string): string[] {
  return [...body.matchAll(/nonce="([^"]*)"/gu)].map((match) => match[1] ?? '');
}

/** A project that handed nonces over to the edge, under `mode`. */
function nonces(mode: 'enforce' | 'report-only' = 'enforce'): Partial<EdgePointer> {
  return { cspNonce: true, cspNonceMode: mode };
}

describe('a gated document of a project that handed nonces over', () => {
  /**
   * A gate answers with a page kept for every visitor, which carries the nonce of the one response it
   * was rendered for: the edge mints one for each response, as it does for a document it composes,
   * and puts it in the page's policy and on every script.
   */
  it('is answered with a nonce minted for that response alone, in its policy and on its scripts', async () => {
    const policy = { [CSP]: `script-src 'self' 'nonce-${KEPT_NONCE}' 'strict-dynamic'` };
    const { gates } = gatesAnswering(() => keptPage(policy));
    const host = hostWith(gates);

    const first = await routed(navigation('/posts/abc'), GATED, host, nonces());
    const second = await routed(navigation('/posts/abc'), GATED, host, nonces());
    const minted = policyNonce(first.response.headers.get(CSP));

    expect(minted).toBeDefined();
    expect(minted).not.toBe(KEPT_NONCE);
    expect(bodyNonces(first.body)).toStrictEqual([minted, minted]);
    expect(policyNonce(second.response.headers.get(CSP))).not.toBe(minted);
    expect(bodyNonces(second.body)).toStrictEqual([
      policyNonce(second.response.headers.get(CSP)),
      policyNonce(second.response.headers.get(CSP)),
    ]);
    expect(first.response.headers.get(EDGE_DEBUG_HEADER)).toBe(`gate;name=${GATE};csp=nonce`);
  });

  /** The gate's length and digests name its saved bytes, which a minted nonce changes. */
  it.each(['GET', 'HEAD'])(
    'removes saved representation metadata from a nonced %s',
    async (method) => {
      const { gates } = gatesAnswering(() => {
        const page = keptPage({
          [CSP]: `script-src 'nonce-${KEPT_NONCE}'`,
          'content-length': '123',
          'content-digest': 'sha-256=:saved:',
          'content-md5': 'saved',
          'repr-digest': 'sha-256=:saved:',
          digest: 'sha-256=saved',
        });
        return method === 'HEAD' ? new Response(null, page) : page;
      });

      const { response } = await routed(
        navigation('/posts/abc', { method }),
        GATED,
        hostWith(gates),
        nonces(),
      );

      expect(response.headers.has('content-length')).toBe(false);
      expect(response.headers.has('content-digest')).toBe(false);
      expect(response.headers.has('content-md5')).toBe(false);
      expect(response.headers.has('repr-digest')).toBe(false);
      expect(response.headers.has('digest')).toBe(false);
    },
  );

  /** A page left as it was keeps the digests and HEAD length that still name its bytes. */
  it.each([
    ['of a project that did not opt in', {}, 'text/html', `script-src 'nonce-${KEPT_NONCE}'`],
    ['with no directive governing scripts', nonces(), 'text/html', "img-src 'self'"],
    ['that is no document', nonces(), 'text/x-component', `script-src 'nonce-${KEPT_NONCE}'`],
  ])('keeps saved representation metadata %s', async (_, settings, type, policy) => {
    const headers = {
      [CSP]: policy,
      'content-type': type,
      'content-length': '123',
      'content-digest': 'sha-256=:saved:',
      'content-md5': 'saved',
      'repr-digest': 'sha-256=:saved:',
      digest: 'sha-256=saved',
    };
    const { gates } = gatesAnswering(() => new Response(null, { headers }));

    const { response } = await routed(
      navigation('/posts/abc', { method: 'HEAD' }),
      GATED,
      hostWith(gates),
      settings,
    );

    expect(response.headers.get('content-length')).toBe(headers['content-length']);
    expect(response.headers.get('content-digest')).toBe(headers['content-digest']);
    expect(response.headers.get('content-md5')).toBe(headers['content-md5']);
    expect(response.headers.get('repr-digest')).toBe(headers['repr-digest']);
    expect(response.headers.get('digest')).toBe(headers.digest);
  });

  /**
   * In Report Only, the page kept as the edge answered it already carries the trial the edge adds:
   * it is tried once, with the nonce minted for this response, and enforced as it was.
   */
  it('tries its policy once in Report Only, with the nonce minted for that response', async () => {
    const policies = {
      [CSP]: "script-src 'self'",
      [REPORT_ONLY]: `script-src 'self' 'nonce-${KEPT_NONCE}'`,
    };
    const { gates } = gatesAnswering(() => keptPage(policies));

    const { response, body } = await routed(
      navigation('/posts/abc'),
      GATED,
      hostWith(gates),
      nonces('report-only'),
    );
    const minted = policyNonce(response.headers.get(REPORT_ONLY));

    expect(response.headers.get(CSP)).toBe("script-src 'self'");
    expect(response.headers.get(REPORT_ONLY)).toBe(`script-src 'self' 'nonce-${minted ?? ''}'`);
    expect(minted).not.toBe(KEPT_NONCE);
    expect(bodyNonces(body)).toStrictEqual([minted, minted]);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe(
      `gate;name=${GATE};csp=nonce;csp-mode=report-only`,
    );
  });

  /**
   * A browser that kept the page asks again with the gate's validator: the gate is asked with none,
   * and answers the page whole, for the edge to stamp it with a nonce of this response's — never a
   * 304, which would have the browser keep the page it holds under a policy naming another nonce.
   */
  it.each([
    ['enforce', { [CSP]: `script-src 'self' 'nonce-${KEPT_NONCE}'` }, CSP],
    [
      'report-only',
      { [CSP]: "script-src 'self'", [REPORT_ONLY]: `script-src 'self' 'nonce-${KEPT_NONCE}'` },
      REPORT_ONLY,
    ],
  ] as const)(
    'is answered whole to a browser that kept it, its nonce this response’s, under %s',
    async (mode, policies, nonced) => {
      const { gates, asked } = gatesAnswering(({ headers }) => {
        return headers.get('if-none-match') === ARTIFACT_TAG
          ? new Response(null, {
              status: 304,
              headers: { ...HTML, ...policies, etag: ARTIFACT_TAG },
            })
          : keptPage({ ...policies, etag: ARTIFACT_TAG });
      });
      const revalidation = navigation('/posts/abc', {
        headers: { 'if-none-match': ARTIFACT_TAG, 'if-modified-since': KEPT_SINCE },
      });

      const { response, body } = await routed(revalidation, GATED, hostWith(gates), nonces(mode));
      const minted = policyNonce(response.headers.get(nonced));

      expect(response.status).toBe(200);
      expect(minted).not.toBe(KEPT_NONCE);
      expect(bodyNonces(body)).toStrictEqual([minted, minted]);
      expect(response.headers.has('etag')).toBe(false);
      expect(asked[0]?.headers.has('if-none-match')).toBe(false);
      expect(asked[0]?.headers.has('if-modified-since')).toBe(false);
    },
  );

  /**
   * A request whose `RSC` is anything but `1` is a document's, as the edge reads one elsewhere: its
   * gate is asked with none of its validators, and the page answered whole, its nonce this
   * response's.
   */
  it('asks the gate of a document whose `RSC` is anything but `1` with none of its validators', async () => {
    const policies = { [CSP]: `script-src 'self' 'nonce-${KEPT_NONCE}'` };
    const { gates, asked } = gatesAnswering(({ headers }) => {
      return headers.get('if-none-match') === ARTIFACT_TAG
        ? new Response(null, { status: 304, headers: { ...HTML, ...policies, etag: ARTIFACT_TAG } })
        : keptPage({ ...policies, etag: ARTIFACT_TAG });
    });
    const revalidation = navigation('/posts/abc', {
      headers: { 'if-none-match': ARTIFACT_TAG, rsc: '0' },
    });

    const { response, body } = await routed(revalidation, GATED, hostWith(gates), nonces());
    const minted = policyNonce(response.headers.get(CSP));

    expect(response.status).toBe(200);
    expect(minted).not.toBe(KEPT_NONCE);
    expect(bodyNonces(body)).toStrictEqual([minted, minted]);
    expect(asked[0]?.headers.has('if-none-match')).toBe(false);
  });

  /** A 304 a gate answers all the same carries no policy: the browser keeps its own with the page. */
  it('gives a 304 its gate answers anyway no policy', async () => {
    const policy = { [CSP]: `script-src 'self' 'nonce-${KEPT_NONCE}'` };
    const unmodified = { status: 304, headers: { ...HTML, ...policy } };
    const { gates } = gatesAnswering(() => new Response(null, unmodified));

    const { response } = await routed(navigation('/posts/abc'), GATED, hostWith(gates), nonces());

    expect(response.status).toBe(304);
    expect(response.headers.has(CSP)).toBe(false);
    expect(response.headers.has(REPORT_ONLY)).toBe(false);
  });

  /** A project that did not opt in keeps its gate's 304, its validator and its policy as given. */
  it('answers a browser that kept a page of a project that did not opt in with its gate’s 304', async () => {
    const policy = { [CSP]: `script-src 'self' 'nonce-${KEPT_NONCE}'` };
    const { gates, asked } = gatesAnswering(({ headers }) => {
      return headers.get('if-none-match') === ARTIFACT_TAG
        ? new Response(null, { status: 304, headers: { ...HTML, ...policy, etag: ARTIFACT_TAG } })
        : keptPage({ ...policy, etag: ARTIFACT_TAG });
    });
    const revalidation = navigation('/posts/abc', { headers: { 'if-none-match': ARTIFACT_TAG } });

    const { response } = await routed(revalidation, GATED, hostWith(gates));

    expect(response.status).toBe(304);
    expect(response.headers.get(CSP)).toBe(policy[CSP]);
    expect(response.headers.get('etag')).toBe(ARTIFACT_TAG);
    expect(asked[0]?.headers.get('if-none-match')).toBe(ARTIFACT_TAG);
  });

  /** A document's media type is read as one, whatever case it is written in. */
  it('is answered with a nonce minted for that response where its type is written in capitals', async () => {
    const policy = { [CSP]: `script-src 'self' 'nonce-${KEPT_NONCE}'` };
    const { gates } = gatesAnswering(() => keptPage(policy, 'Text/HTML; Charset=UTF-8'));

    const { response, body } = await routed(
      navigation('/posts/abc'),
      GATED,
      hostWith(gates),
      nonces(),
    );
    const minted = policyNonce(response.headers.get(CSP));

    expect(minted).not.toBe(KEPT_NONCE);
    expect(bodyNonces(body)).toStrictEqual([minted, minted]);
  });

  /** Nothing is minted for a project that did not opt in, nor for an answer that is no document. */
  it.each([
    ['of a project that did not opt in', {}, 'text/html; charset=utf-8'],
    ['that is no document', nonces(), 'text/x-component'],
  ])('leaves a gate’s answer %s as the gate gave it', async (_, settings, type) => {
    const policy = { [CSP]: `script-src 'self' 'nonce-${KEPT_NONCE}'` };
    const { gates } = gatesAnswering(() => keptPage(policy, type));

    const { response, body } = await routed(
      navigation('/posts/abc'),
      GATED,
      hostWith(gates),
      settings,
    );

    expect(response.headers.get(CSP)).toBe(policy[CSP]);
    expect(bodyNonces(body)).toStrictEqual([KEPT_NONCE]);
  });
});

/**
 * The rules of `next.config` the posts are given: one every request matches, one a request's header
 * chooses, and a cookie.
 */
const POST_RULES: readonly HeaderRule[] = [
  { sourceRegex: POST_PATTERN, headers: { 'x-frame-options': 'DENY' } },
  {
    sourceRegex: POST_PATTERN,
    has: [{ type: 'header', key: 'x-embed' }],
    headers: { 'access-control-allow-origin': '*' },
  },
  { sourceRegex: POST_PATTERN, headers: { 'set-cookie': 'seen=1; Path=/' } },
];

/**
 * A page a gate keeps for every visitor, as the request it was made for was answered: under the rule
 * every request matches, with no cookie — and the gate's own cookie beside it.
 */
function keptUnderRules(): Response {
  return new Response('kept', {
    headers: { 'content-type': 'text/plain', 'x-frame-options': 'DENY', 'set-cookie': 'gate=1' },
  });
}

describe('a gate’s answer under the rules of next.config', () => {
  /**
   * Laid over it as the deployment's router lays them over its Function's answer: the rule a
   * request's header chooses for that request alone, the one every request matches once, a
   * cookie beside the gate's own.
   */
  it('carries the rules this request matches, as the Function’s answer of it would', async () => {
    const { gates } = gatesAnswering(() => keptUnderRules());
    const site = { ...GATED, headerRules: POST_RULES };

    const plain = await routed(navigation('/posts/abc'), site, hostWith(gates));
    const embedded = await routed(
      navigation('/posts/abc', { headers: { 'x-embed': '1' } }),
      site,
      hostWith(gates),
    );

    expect(plain.response.headers.get('x-frame-options')).toBe('DENY');
    expect(plain.response.headers.has('access-control-allow-origin')).toBe(false);
    expect(embedded.response.headers.get('access-control-allow-origin')).toBe('*');
    expect(plain.response.headers.getSetCookie()).toStrictEqual(['gate=1', 'seen=1; Path=/']);
  });

  /**
   * A rule that costs more against the request than the edge runs leaves the answer's headers
   * unknown: answered as a request whose gate cannot be found in time is, never handed on.
   */
  it('is answered that its gate is unavailable where a rule costs more than the edge runs', async () => {
    const { gates } = gatesAnswering(() => keptUnderRules());
    const site = {
      ...GATED,
      headerRules: [{ sourceRegex: QUADRATIC, headers: { 'x-frame-options': 'DENY' } }],
    };

    const { response, functionAsked } = await routed(
      navigation(`/posts/${'a'.repeat(4096)}`),
      site,
      hostWith(gates),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-pattern-budget');
    expect(functionAsked).toStrictEqual([]);
  });
});

describe('a gate cannot take over the visitor WebSocket', () => {
  it.each([false, true])(
    'fails closed on a native gate upgrade with pass marker %s',
    async (pass) => {
      const pair = new WebSocketPair();
      const peer = pair[1];
      peer.accept();
      const closed = new Promise<void>((resolve) => {
        peer.addEventListener(
          'close',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      const { gates } = gatesAnswering(() => {
        return new Response(null, {
          // eslint-disable-next-line unicorn/no-invalid-response-options -- A native Worker upgrade carries its WebSocket beside status 101.
          status: 101,
          webSocket: pair[0],
          headers: pass ? { [GATE_ANSWER_HEADER]: GATE_PASS } : {},
        });
      });
      try {
        const { response, functionAsked } = await routed(
          navigation('/posts/abc', { headers: { upgrade: 'websocket' } }),
          GATED,
          hostWith(gates),
        );

        expect(response.status).toBe(503);
        expect(response.webSocket).toBeNull();
        expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-unavailable');
        expect(functionAsked).toStrictEqual([]);

        await closed;
      } finally {
        if (peer.readyState === WebSocket.OPEN) peer.close();
      }
    },
  );

  it.each([false, true])(
    'rejects an attached gate socket before reading pass marker %s',
    async (pass) => {
      const pair = new WebSocketPair();
      const peer = pair[1];
      peer.accept();
      const closed = new Promise<void>((resolve) => {
        peer.addEventListener(
          'close',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      const answer = new Response(null, {
        headers: pass ? { [GATE_ANSWER_HEADER]: GATE_PASS } : {},
      });
      Object.defineProperty(answer, 'webSocket', { value: pair[0] });
      const { gates } = gatesAnswering(() => answer);
      try {
        const { response, functionAsked } = await routed(
          navigation('/posts/abc'),
          GATED,
          hostWith(gates),
        );

        expect(response.status).toBe(503);
        expect(response.webSocket).toBeNull();
        expect(functionAsked).toStrictEqual([]);

        await closed;
      } finally {
        if (peer.readyState === WebSocket.OPEN) peer.close();
      }
    },
  );
});

describe('a route whose gate cannot say', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Never served as though there were no gate, nor from what the edge holds of the route. */
  it('is answered that the gate is unavailable where the host has no gates', async () => {
    const { response, functionAsked } = await routed(
      navigation('/posts/abc'),
      GATED,
      hostWith(undefined),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-unavailable');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(functionAsked).toStrictEqual([]);
  });

  it('is answered that the gate is unavailable where its gate fails', async () => {
    const { gates } = gatesAnswering(() => {
      throw new Error('the gate broke');
    });

    const { response, functionAsked } = await routed(
      navigation('/posts/abc'),
      GATED,
      hostWith(gates),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-unavailable');
    expect(functionAsked).toStrictEqual([]);
  });

  it('is answered that the gate is unavailable where its gate does not answer in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const signals: AbortSignal[] = [];
    const { promise: reached, resolve: reach } = Promise.withResolvers<undefined>();
    const gates: EdgeGates = {
      answer: async (_name, request): Promise<Response> => {
        signals.push(request.signal);
        reach(undefined);
        return new Promise<Response>(() => {
          // Never answers.
        });
      },
    };

    const answering = routed(navigation('/posts/abc'), GATED, hostWith(gates));
    // The deadline is set as the gate is asked: what is waited for from here is the gate alone.
    await reached;
    await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS);
    const { response, functionAsked } = await answering;

    expect(response.status).toBe(503);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-unavailable');
    expect(functionAsked).toStrictEqual([]);
    // Cancelled, not left to answer once the visitor has been told.
    expect(signals.map((signal) => signal.aborted)).toStrictEqual([true]);
  });

  /**
   * A request whose route could not be found within what the edge spends testing the application's
   * patterns may be of a gated route: answered as one whose gate could not say, never handed on.
   */
  it('is answered that its gate is unavailable where its route cannot be found in time', async () => {
    const { gates, asked } = gatesAnswering(() => passing());
    const site = {
      ...GATED,
      dynamicRoutes: [{ sourceRegex: QUADRATIC, route: POST, gated: POST }],
    };

    const { response, functionAsked } = await routed(navigation(CRAFTED), site, hostWith(gates));

    expect(response.status).toBe(503);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-pattern-budget');
    expect(asked).toStrictEqual([]);
    expect(functionAsked).toStrictEqual([]);
  });
});

describe('a request no gate is asked about', () => {
  /** A Server Action, and every other method, is the Function's, as it is with no gate. */
  it('hands a POST of a gated route to the Function', async () => {
    const { gates, asked } = gatesAnswering(() => new Response('revoked', { status: 403 }));
    const posted = navigation('/posts/abc', {
      method: 'POST',
      body: 'form',
      headers: { 'next-action': 'abc123' },
    });

    const { body, functionAsked } = await routed(posted, GATED, hostWith(gates));

    expect(asked).toStrictEqual([]);
    expect(body).toBe('from the Function');
    expect(functionAsked).toStrictEqual(['/posts/abc']);
  });

  /** A route the build declared no gate for is served as it always was. */
  it('serves a route with no gate of a deployment that declares one as it always did', async () => {
    const { gates, asked } = gatesAnswering(() => new Response('revoked', { status: 403 }));
    const site = {
      ...GATED,
      pathname: '/',
      dynamicRoutes: [{ sourceRegex: POST_PATTERN, gated: POST }],
    };

    const { response } = await routed(navigation('/'), site, hostWith(gates));

    expect(asked).toStrictEqual([]);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toMatch(/^shell;/u);
  });

  /** And a deployment that declares none never asks the host's gates anything. */
  it('asks nothing of a deployment that declares no gate', async () => {
    const { gates, asked } = gatesAnswering(() => new Response('revoked', { status: 403 }));

    const { response } = await routed(navigation('/posts/abc'), UNGATED, hostWith(gates));

    expect(asked).toStrictEqual([]);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toMatch(/^shell;/u);
  });
});

describe('a file a gated class’s pattern holds of', () => {
  /**
   * What the deployment before shipped, kept for the documents still open of it, is answered ahead
   * of every route, as the build's own files are: by its name, and by the deployment a request
   * names. No gate is asked of it, whichever class's pattern holds of its path.
   */
  it.each([
    ['by its name', '/posts/logo.txt'],
    ['by the deployment a request names', `/posts/logo.txt?dpl=${KEPT_DEPLOYMENT}`],
  ])('is served kept from the deployment before %s, no gate asked', async (_, path) => {
    const { gates, asked } = gatesAnswering(() => new Response('denied', { status: 403 }));
    const site = { ...GATED, keptFiles: { '/posts/logo.txt': 'kept' } };

    const { response, body, functionAsked } = await routed(
      new Request(`https://site.example${path}`),
      site,
      hostWith(gates),
    );

    expect(response.status).toBe(200);
    expect(body).toBe('kept');
    expect(asked).toStrictEqual([]);
    expect(functionAsked).toStrictEqual([]);
  });
});

describe('a standalone edge’s gates', () => {
  /** Each over the service binding its name names (`gateBinding`), told the route on the request. */
  it('hands the gate bound under its name the request, told the route it is of', async () => {
    const received: Request[] = [];
    const site = {
      ...env,
      [gateBinding('content-rules')]: {
        fetch: (request: Request): Promise<Response> => {
          received.push(request);
          return Promise.resolve(passing());
        },
      },
    } as StandaloneEnv;

    const answer = await standaloneHost(site).gates?.answer(
      'content-rules',
      new Request('https://site.example/posts/abc'),
      POST,
    );

    expect(gateBinding('content-rules')).toBe('GATE__CONTENT_RULES');
    expect(answer?.headers.get(GATE_ANSWER_HEADER)).toBe(GATE_PASS);
    expect(received.map((request) => request.headers.get(GATE_ROUTE_HEADER))).toStrictEqual([POST]);
  });

  /** One it is not bound to answers no request of its routes as though there were no gate. */
  it('answers that a gate it is not bound to is unavailable', async () => {
    const document = pprDocument();
    const { pointer } = await seedSite({ document, ...GATED });
    const site: StandaloneEnv = { ...env, POINTER: JSON.stringify(pointer) };
    const ctx = createExecutionContext();
    const runtime = standaloneRuntime(site, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: (): Promise<Response> => Promise.resolve(htmlResponse(document.suffix)),
    });

    const response = await handleStandalone(navigation('/posts/abc'), site, ctx, runtime);
    await response.text();
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(503);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-unavailable');
  });
});

/** `next/image` as a build configures it: any source of the site's own, and one host's. */
const IMAGES: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  dangerouslyAllowLocalIP: false,
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [
    { protocol: 'https', hostname: String.raw`^cdn\.site\.example$`, pathname: '^.*$' },
  ],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};

/** An image, as whatever is asked for one answers. */
function png(): Response {
  const bytes = concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encodeUtf8('png'),
  ]);
  return new Response(bytes, { headers: { 'content-type': 'image/png' } });
}

/**
 * A browser's request for an optimized image of `source`, served by a host whose gates let every
 * request on, of the gated site configured for `next/image`: the answer, what the gates were asked,
 * and what the deployment's Function and the internet were asked for — each answering an image.
 */
async function imaged(
  source: string,
  site: Omit<SiteOptions, 'document'> = GATED,
  validated = false,
): Promise<{
  readonly response: Response;
  readonly body: string;
  readonly asked: readonly Asked[];
  readonly functionAsked: readonly string[];
  readonly fetched: readonly string[];
}> {
  const { manifest, pointer } = await seedSite({
    document: pprDocument(),
    ...site,
    images: IMAGES,
  });
  const { gates, asked } = gatesAnswering(() => passing());
  const functionAsked: string[] = [];
  const fetched: string[] = [];
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (_: string, dispatched: Request): Promise<Response> => {
      functionAsked.push(new URL(dispatched.url).pathname);
      return Promise.resolve(png());
    },
    fetchImpl: (fetching): Promise<Response> => {
      fetched.push(new Request(fetching).url);
      return Promise.resolve(png());
    },
  });
  const query = `url=${encodeURIComponent(source)}&w=64&q=75`;
  const request: IncomingRequest = new Request(`https://site.example/_next/image?${query}`, {
    headers: { accept: 'image/webp,image/*,*/*;q=0.8', 'sec-fetch-dest': 'image' },
  });
  const ctx = createExecutionContext();
  const shared = {
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host: hostWith(gates),
  };
  const response = await (validated
    ? routeRequest({
        ...shared,
        state: {
          ...manifestStateFromPointer({
            runtime,
            pointer,
            stored: { kind: 'found', value: manifest },
            pathname: shared.url.pathname,
            privateDelivery: false,
            cspReportingPath: undefined,
          }),
          policy: DEFAULT_DELIVERY_POLICY,
          cacheApi: false,
          validated: true,
          passthroughReason: 'validation',
          demotedRoutes: undefined,
        },
        timings: { pointerMs: undefined, manifestMs: 0, middlewareMs: undefined },
      })
    : serveFromPointer({
        ...shared,
        pointer,
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      }));
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body, asked, functionAsked, fetched };
}

describe('an image the optimizer is asked for', () => {
  /**
   * What the optimizer makes of a source is kept for every visitor, and every answer of a gated
   * route is its gate's: such a source is refused as Next.js refuses an internal one that is no
   * image, before anything is fetched or kept — asked again, it is refused again.
   */
  it('is refused, its gate and the Function never asked, where its source is a gated route', async () => {
    const first = await imaged('/posts/abc');
    const again = await imaged('/posts/abc');

    for (const { response, body, asked, functionAsked, fetched } of [first, again]) {
      expect(response.status).toBe(400);
      expect(body).toBe('"url" parameter is valid but internal response is invalid');
      expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=image-source-gated');
      expect(asked).toStrictEqual([]);
      expect(functionAsked).toStrictEqual([]);
      expect(fetched).toStrictEqual([]);
    }
  });

  /** Validation bypasses route admission and keeps the optimizer's source restrictions. */
  it('keeps a gated source unsupported under accepted validation', async () => {
    const { response, body, asked, functionAsked, fetched } = await imaged(
      '/posts/abc',
      GATED,
      true,
    );

    expect(response.status).toBe(400);
    expect(body).toBe('"url" parameter is valid but internal response is invalid');
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=image-source-gated');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(asked).toStrictEqual([]);
    expect(functionAsked).toStrictEqual([]);
    expect(fetched).toStrictEqual([]);
  });

  /**
   * A source whose route could not be found within what the edge spends testing the application's
   * patterns may be of a gated route: refused as the gate of one could not say, as a request of
   * the route itself is, and never handed to the Function, whose optimizer would fetch it with no
   * gate asked and keep what it made of it for every visitor.
   */
  it('is refused where its source’s route cannot be found in time', async () => {
    const site = {
      ...GATED,
      dynamicRoutes: [{ sourceRegex: QUADRATIC, route: POST, gated: POST }],
    };

    const { response, asked, functionAsked, fetched } = await imaged(CRAFTED_SOURCE, site);

    expect(response.status).toBe(503);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-pattern-budget');
    expect(asked).toStrictEqual([]);
    expect(functionAsked).toStrictEqual([]);
    expect(fetched).toStrictEqual([]);
  });

  /** A deployment that declares no gate asks nothing of its sources' routes, and goes on as before. */
  it('goes on as before for a deployment that declares no gate', async () => {
    const site = {
      ...UNGATED,
      dynamicRoutes: [{ sourceRegex: QUADRATIC, route: POST }],
    };

    const { response, asked, functionAsked } = await imaged(CRAFTED_SOURCE, site);

    expect(response.status).toBe(200);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toMatch(/^image;src=source;/u);
    expect(asked).toStrictEqual([]);
    expect(functionAsked).toStrictEqual([CRAFTED_SOURCE]);
  });

  it('fetches a source of the application’s own with no gate, and one of the internet, as before', async () => {
    const own = await imaged('/photo.png');
    const remote = await imaged('https://cdn.site.example/a.png');

    expect(own.response.status).toBe(200);
    expect(own.functionAsked).toStrictEqual(['/photo.png']);
    expect(remote.response.status).toBe(200);
    expect(remote.fetched).toStrictEqual(['https://cdn.site.example/a.png']);
    expect([...own.asked, ...remote.asked]).toStrictEqual([]);
  });
});
