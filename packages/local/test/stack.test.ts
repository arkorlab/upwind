import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { OUT_DIR_NAME } from '@stayingupwind/adapter';
import {
  type BlobRef,
  type DeploymentBundle,
  type FunctionSpec,
  SPLIT_BUNDLE_VERSION,
} from '@stayingupwind/core/bundle';
import { EDGE_BYPASS_COOKIE } from '@stayingupwind/core/request';
import { createId } from '@stayingupwind/core/util';
import {
  CACHE_INTERNAL_ORIGIN,
  CACHE_READ_INTERNAL_ORIGIN,
  PREFETCH_BLOB_PATH,
  PREFETCH_INTERNAL_ORIGIN,
} from '@stayingupwind/host/bindings';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkStack } from '../src/check.ts';
import { loopbackFor } from '../src/ports.ts';
import { type LocalStack, siteNamesOf, siteUrlOf, startStack } from '../src/stack.ts';

/**
 * A stack started on a bundle of a few small modules rather than a build: what the stack does
 * itself — bind, deploy, forward — without anything Next.js does.
 */

const ASSET_PATH = '/_next/static/chunks/asset.js';
const ASSET = 'console.log("served from the bucket");';
const ASSET_SHA256 = createHash('sha256').update(ASSET).digest('hex');
const START_MS = 60_000;
const DATA = '{"from":"a JSON module","list":[1,2]}';
/** Whether a stack serves on the IPv6 loopback here: not on a machine that has none. */
const IPV6 = (await loopbackFor(undefined)).hosts.includes('::1');

/** A document by its digest and length, as the backstage answers one it stamped again. */
function digestOf(document: string): { sha256: string; length: number } {
  const sha256 = createHash('sha256').update(document).digest('hex');
  return { sha256, length: Buffer.byteLength(document) };
}

/**
 * The deployment's one Function: what reached it, and what its bindings answer. Like an application
 * that judges the host it is asked under, it fails the check's miss where it does not reach it
 * under the site's own.
 */
const APP = `
import data from './data.json';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/sized') {
      // A \`HEAD\` answered as an application answers one: no body, and the length of the \`GET\`'s.
      return new Response(request.method === 'HEAD' ? null : 'twelve bytes', {
        headers: { 'content-length': '12', 'content-type': 'text/plain' },
      });
    }
    if (url.pathname === '/json') {
      return Response.json(data);
    }
    if (url.pathname === '/cf') {
      return Response.json({
        url: request.url,
        host: request.headers.get('host'),
        protocol: request.headers.get('x-forwarded-proto'),
        clientCodings: request.cf?.clientAcceptEncoding ?? null,
        codings: request.headers.get('accept-encoding'),
      });
    }
    if (url.pathname === '/self') {
      // A page of the site's own, fetched as an application fetches one: by the URL it was asked at.
      const answer = await fetch(new URL('/echo?from=self', request.url));
      return Response.json({ status: answer.status, echoed: await answer.json() });
    }
    if (url.pathname === '/self-alias') {
      // Address the alias inside the Function, independent of Miniflare's listening socket.
      const target = new URL('http://alias.invalid/echo?from=self');
      const answer = await fetch(target, { headers: { host: target.host } });
      return Response.json({ status: answer.status, echoed: await answer.json() });
    }
    if (url.pathname === '/self-default-port') {
      const target = new URL('https://default-port.invalid:443/echo?from=default-port');
      target.protocol = 'http:';
      const answer = await fetch(target, { headers: { host: target.host } });
      return Response.json({ status: answer.status, echoed: await answer.json() });
    }
    if (url.pathname.startsWith('/_upwind-local-check/') && url.hostname !== 'localhost') {
      return new Response('asked under ' + url.host, { status: 500 });
    }
    if (url.pathname === '/kv') {
      await env.APP_KV.put('key', 'stored');
      return Response.json({ stored: await env.APP_KV.get('key'), listed: env.ARKOR_RESOURCES });
    }
    if (url.pathname !== '/bindings') {
      return Response.json({
        url: request.url,
        host: request.headers.get('host'),
        forwarded: request.headers.get('x-forwarded-host'),
        protocol: request.headers.get('x-forwarded-proto'),
        trace: request.headers.get('x-upwind-trace'),
        codings: request.headers.get('accept-encoding'),
        done: request.headers.get('x-arkor-middleware-done'),
        changes: env.ARKOR_RESOURCE_CHANGES ?? null,
        deployment: env.NEXT_DEPLOYMENT_ID,
        runtime: env.ARKOR_RUNTIME,
        value: env.TEST_VALUE,
      });
    }
    const scope = ${JSON.stringify(CACHE_INTERNAL_ORIGIN)} + '/v1/scopes/' + env.NEXT_DEPLOYMENT_ID;
    const answers = await Promise.all([
      env.ARKOR_CACHE.fetch(scope + '/entries/resolve', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + env.ARKOR_CACHE_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ entry: { kind: 'app-page', route: '/', pathname: '/' } }),
      }),
      env.ARKOR_CACHE_READ.fetch(${JSON.stringify(CACHE_READ_INTERNAL_ORIGIN)} + '/v1/healthz'),
      env.ARKOR_PREFETCH.fetch(
        ${JSON.stringify(PREFETCH_INTERNAL_ORIGIN + PREFETCH_BLOB_PATH + ASSET_SHA256)},
      ),
    ]);
    return Response.json(await Promise.all(answers.map(async (answer) => {
      await answer.arrayBuffer();
      return answer.status;
    })));
  },
};
`;

/** The build's second app Function, which holds none of the routes the first does. */
const SECOND = `
export default {
  fetch(request) {
    return Response.json({
      function: 'app-2',
      done: request.headers.get('x-arkor-middleware-done'),
    });
  },
};
`;

/** What the edge says of an answer, part by part. */
function accountOf(answer: Response): string[] {
  return (answer.headers.get('x-arkor-edge') ?? '').split(';');
}

/** A build of the two Functions and the one asset, under `dir` as the adapter writes one. */
async function writeBundle(dir: string, middleware?: string): Promise<void> {
  const bundleDir = path.join(dir, OUT_DIR_NAME);
  const blobs = path.join(bundleDir, 'blobs');
  await mkdir(blobs, { recursive: true });
  const blob = async (contents: string, contentType: string): Promise<BlobRef> => {
    const bytes = Buffer.from(contents);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(blobs, sha256), bytes);
    return { sha256, byteLength: bytes.byteLength, contentType };
  };
  const app: FunctionSpec = {
    mainModule: 'index.mjs',
    modules: [
      { name: 'index.mjs', type: 'esm', blob: await blob(APP, 'text/javascript') },
      // A JSON module, which the Function imports as the value it parses to.
      { name: 'data.json', type: 'json', blob: await blob(DATA, 'application/json') },
    ],
    compatibilityDate: '2026-09-15',
    compatibilityFlags: [],
  };
  const second: FunctionSpec = {
    ...app,
    modules: [{ name: 'index.mjs', type: 'esm', blob: await blob(SECOND, 'text/javascript') }],
  };
  const middlewareFunction: FunctionSpec | undefined =
    middleware === undefined
      ? undefined
      : {
          ...app,
          modules: [
            { name: 'index.mjs', type: 'esm', blob: await blob(middleware, 'text/javascript') },
          ],
        };
  const bundle: DeploymentBundle = {
    // A bundle split across Functions says so by its version.
    v: SPLIT_BUNDLE_VERSION,
    deploymentId: createId('dpl'),
    // A release a deploy accepts (`nextVersionSupported`), from before 16.3: its crawlers are
    // served no shell.
    nextVersion: '16.2.4',
    buildId: 'test',
    projectDir: '.',
    generatedAt: new Date().toISOString(),
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: true,
      poweredByHeader: false,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'rsc',
        varyHeader: 'rsc',
        prefetchHeader: 'next-router-prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: 'text/x-component',
        suffix: '.rsc',
        prefetchSegmentHeader: 'next-router-segment-prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    // The route the second Function holds: a route handler, which no check of a page reaches.
    entrypoints: [
      { id: 'app/api/second/route', kind: 'app-route', pathname: '/api/second', function: 'app-2' },
    ],
    prerenders: [],
    staticFiles: [
      { pathname: ASSET_PATH, blob: await blob(ASSET, 'text/javascript'), immutable: true },
    ],
    // Split across two, as a build whose routes the adapter splits is.
    functions: {
      app,
      split: { 'app-2': second },
      ...(middlewareFunction !== undefined && { middleware: middlewareFunction }),
    },
    ...(middlewareFunction !== undefined && {
      middleware: {
        matchers: [{ sourceRegex: '^/guard$', has: [{ type: 'header', key: 'via' }] }],
      },
    }),
  };
  await writeFile(path.join(bundleDir, 'bundle.json'), JSON.stringify(bundle));
}

describe("the names a stack's site goes by", () => {
  it('takes each a check names it by as a request over HTTPS names it, beside its own', () => {
    const names = siteNamesOf({ hosts: ['127.0.0.1', '::1'], port: 8787 }, [
      'example.com:443',
      'Alias.Example:8443',
    ]);

    expect(names).toStrictEqual({
      hostnames: 'localhost,127.0.0.1,[::1],example.com,alias.example',
      origins: [
        'http://localhost:8787',
        'https://localhost:8787',
        'http://127.0.0.1:8787',
        'https://127.0.0.1:8787',
        'http://[::1]:8787',
        'https://[::1]:8787',
        'https://example.com',
        'https://alias.example:8443',
        'http://example.com:443',
        'http://example.com',
        'http://alias.example:8443',
      ].join(','),
    });
  });

  it("names its own socket at a scheme's default port as a URL of that scheme writes it", () => {
    const secure = siteNamesOf({ hosts: ['127.0.0.1'], port: 443 }, []);
    const plain = siteNamesOf({ hosts: ['127.0.0.1'], port: 80 }, []);

    expect(secure.origins).toBe(
      'http://localhost:443,https://localhost,http://127.0.0.1:443,https://127.0.0.1',
    );
    expect(plain.origins).toBe(
      'http://localhost,https://localhost:80,http://127.0.0.1,https://127.0.0.1:80',
    );
  });
});

describe('a local stack', () => {
  const state: { dir?: string; stack?: LocalStack } = {};

  function started(): LocalStack {
    if (state.stack === undefined) {
      throw new Error('the stack did not start');
    }
    return state.stack;
  }

  beforeAll(async () => {
    state.dir = await mkdtemp(path.join(tmpdir(), 'upwind-local-stack-'));
    await writeBundle(state.dir);
    state.stack = await startStack({
      bundleDir: path.join(state.dir, OUT_DIR_NAME),
      // A name the deploy binds itself yields to it, as it does deployed.
      env: {
        TEST_VALUE: 'the application’s',
        ARKOR_CACHE: 'the application’s too',
        // A name of the host's contract the stack binds nothing under: still never the application's.
        ARKOR_RESOURCE_CHANGES: 'the application’s as well',
      },
      storage: { kv: ['APP_KV'] },
      hostnames: ['alias.invalid', 'default-port.invalid:443'],
    });
  }, START_MS);

  afterAll(async () => {
    await state.stack?.dispose();
    if (state.dir !== undefined) {
      await rm(state.dir, { recursive: true, force: true });
    }
  });

  /**
   * What a client is handed over the wire for a `HEAD`: the `Content-Length` the Function gave its
   * answer, the length of the `GET`'s body. The runtime sends a length for a `HEAD` only where the
   * answer carries one, there being no body to frame by, so the edge keeps it on (Codex, upwind#179).
   */
  it('hands a client the length a Function gave its answer to HEAD', async () => {
    const stack = started();

    const head = await fetch(new URL('/sized', stack.url), { method: 'HEAD' });
    const get = await fetch(new URL('/sized', stack.url));

    expect([head.status, head.headers.get('content-length')]).toStrictEqual([200, '12']);
    expect([get.headers.get('content-length'), await get.text()]).toStrictEqual([
      '12',
      'twelve bytes',
    ]);
  });

  it('hands a Function what the edge forwards under the origin the visitor used', async () => {
    const stack = started();

    const response = await fetch(new URL('/echo?q=1', stack.url));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      url: new URL('/echo?q=1', stack.url).href,
      host: stack.url.host,
      forwarded: stack.url.host,
      protocol: 'http',
      trace: null,
      // As Cloudflare's front line hands a Worker every request, whatever the visitor accepts.
      codings: 'gzip, br',
      done: null,
      changes: null,
      deployment: stack.deploymentId,
      runtime: 'workerd',
      value: 'the application’s',
    });
  });

  it('hands a Function a request accepting what the front line sets, whatever the visitor accepts', async () => {
    const stack = started();

    const unencoded = await fetch(new URL('/echo', stack.url), {
      headers: { 'accept-encoding': 'identity' },
    });
    const zstd = await fetch(new URL('/echo', stack.url), {
      headers: { 'accept-encoding': 'zstd' },
    });

    await expect(unencoded.json()).resolves.toMatchObject({ codings: 'gzip, br' });
    await expect(zstd.json()).resolves.toMatchObject({ codings: 'gzip, br' });
  });

  it.each([
    { scheme: 'http', coding: 'identity' },
    { scheme: 'https', coding: 'zstd' },
  ])('keeps the visitor’s cf codings when forwarding over $scheme', async ({ scheme, coding }) => {
    const stack = started();
    const expected = new URL('/cf', stack.url);
    expected.protocol = `${scheme}:`;

    const response = await fetch(new URL('/cf', stack.url), {
      headers: { 'accept-encoding': coding, 'x-forwarded-proto': scheme },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      url: expected.href,
      host: expected.host,
      protocol: scheme,
      clientCodings: coding,
      codings: 'gzip, br',
    });
  });

  it(
    'asks standalone middleware with the forwarded Via and without internal or recovery fields',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'upwind-local-middleware-view-'));
      let stack: LocalStack | undefined;
      try {
        await writeBundle(
          dir,
          `export default {
          fetch(request) {
            const cookie = request.headers.get('cookie') ?? '';
            const valid = request.headers.get('via') === '1.1 arkor-edge'
              && request.headers.get('x-arkor-test') === null
              && cookie === 'session=kept';
            return valid
              ? new Response(null, { headers: { 'x-middleware-next': '1' } })
              : new Response('incorrect forwarding view', { status: 500 });
          },
        };`,
        );
        stack = await startStack({ bundleDir: path.join(dir, OUT_DIR_NAME) });
        const response = await fetch(new URL('middleware?path=/guard', stack.backstage), {
          headers: {
            via: 'the visitor',
            'x-arkor-test': 'untrusted',
            cookie: `session=kept; ${EDGE_BYPASS_COOKIE}=1`,
          },
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ kind: 'continue', status: 200 });
      } finally {
        await stack?.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
    START_MS,
  );

  it('hands a Function a request said to come over HTTPS under that origin, as a check’s is', async () => {
    const stack = started();

    const response = await fetch(new URL('/echo?q=1', stack.url), {
      headers: { 'x-forwarded-proto': 'https' },
    });

    await expect(response.json()).resolves.toMatchObject({
      url: `https://${stack.url.host}/echo?q=1`,
      host: stack.url.host,
      protocol: 'https',
    });
  });

  it("sends a page a Function fetches of the site's own to the edge, under the origin it was asked at", async () => {
    const stack = started();

    // Under HTTPS, as a check's request is, which the edge's plain socket does not speak.
    const response = await fetch(new URL('/self', stack.url), {
      headers: { 'x-forwarded-proto': 'https' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 200,
      echoed: { url: `https://${stack.url.host}/echo?from=self`, protocol: 'https' },
    });
  });

  it('keeps a Function HTTP self-fetch under a configured alias on its own edge', async () => {
    const stack = started();
    const response = await fetch(new URL('/self-alias', stack.url));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 200,
      echoed: { url: 'http://alias.invalid/echo?from=self', protocol: 'http' },
    });
  });

  it('keeps a Function HTTP self-fetch after its HTTPS alias dropped the default port', async () => {
    const response = await fetch(new URL('/self-default-port', started().url));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 200,
      echoed: { url: 'http://default-port.invalid/echo?from=default-port', protocol: 'http' },
    });
  });

  it('traces a request only under an id a check registered, which no Function sees', async () => {
    const stack = started();
    const echoed = async (trace: string): Promise<unknown> => {
      const response = await fetch(new URL('/echo', stack.url), {
        headers: { 'x-upwind-trace': trace },
      });
      const { trace: seen } = (await response.json()) as { trace: unknown };
      return seen;
    };

    // A visitor's own header of the name reaches the site as it would deployed.
    const visitor = await echoed('visitor');
    const registered = await fetch(new URL('trace/checked', stack.backstage), { method: 'PUT' });
    const checked = await echoed('checked');
    // Good for one request: asked again, the id is a visitor's header again.
    const again = await echoed('checked');
    // Registered with a value of the header's own, which the request goes on with in its place.
    await fetch(new URL('trace/carried?as=its-own', stack.backstage), { method: 'PUT' });
    const carried = await echoed('carried');
    // No middleware ran and nothing was regenerated, so nothing was kept but the request itself.
    const kept = await fetch(new URL('trace/checked', stack.backstage));
    // Read once; and an id no request came in under is none the stack knows.
    const reread = await fetch(new URL('trace/checked', stack.backstage));
    const unknown = await fetch(new URL('trace/visitor', stack.backstage));
    // Nor has the edge read any generation of a record, of which this build has none.
    const generation = await fetch(new URL('generation/scope/entry/1', stack.backstage));

    expect(registered.status).toBe(204);
    expect([visitor, checked, again, carried]).toStrictEqual([
      'visitor',
      null,
      'checked',
      'its-own',
    ]);
    await expect(kept.json()).resolves.toStrictEqual({
      decision: null,
      regenerated: null,
      generations: {},
    });
    expect([reread.status, unknown.status]).toStrictEqual([404, 404]);
    await expect(generation.json()).resolves.toBeNull();
    expect(stack.backstage.port).not.toBe(stack.url.port);
  });

  it('lets go of what it kept of a traced request a check is done with, unread', async () => {
    const stack = started();
    await fetch(new URL('trace/done', stack.backstage), { method: 'PUT' });
    const answer = await fetch(new URL('/echo', stack.url), {
      headers: { 'x-upwind-trace': 'done' },
    });
    await answer.arrayBuffer();
    // And one registered for a request that never came, which no request is to be traced under.
    await fetch(new URL('trace/unsent', stack.backstage), { method: 'PUT' });

    const letGo = await Promise.all(
      ['done', 'unsent'].map(async (id) => {
        const response = await fetch(new URL(`trace/${id}`, stack.backstage), { method: 'DELETE' });
        return response.status;
      }),
    );
    const kept = await fetch(new URL('trace/done', stack.backstage));
    const traced = await fetch(new URL('/echo', stack.url), {
      headers: { 'x-upwind-trace': 'unsent' },
    });

    expect(letGo).toStrictEqual([204, 204]);
    expect(kept.status).toBe(404);
    // A visitor's own header of the name, as for an id never registered.
    await expect(traced.json()).resolves.toMatchObject({ trace: 'unsent' });
  });

  it('lets go of the oldest traces no check read past its bound, never the one read next', async () => {
    const stack = started();
    const traced = async (trace: string): Promise<void> => {
      await fetch(new URL(`trace/${trace}`, stack.backstage), { method: 'PUT' });
      const answer = await fetch(new URL('/echo', stack.url), {
        headers: { 'x-upwind-trace': trace },
      });
      await answer.arrayBuffer();
    };
    // More than the stack keeps, none of them read — as of requests no middleware ran on — and
    // then one a check reads as soon as its answer is in.
    const unread = Array.from({ length: 300 }, (_, index) => `unread-${index}`);
    for (const trace of unread) {
      await traced(trace);
    }
    await traced('read');
    const read = await fetch(new URL('trace/read', stack.backstage));
    const oldest = await fetch(new URL('trace/unread-0', stack.backstage));
    const newest = await fetch(new URL('trace/unread-299', stack.backstage));

    expect([read.status, oldest.status, newest.status]).toStrictEqual([200, 404, 200]);
  });

  it('answers on the IPv4 loopback address, under the origin the request came in on', async () => {
    const { port } = started().url;

    const v4 = await fetch(`http://127.0.0.1:${port}/echo`);

    await expect(v4.json()).resolves.toMatchObject({
      url: `http://127.0.0.1:${port}/echo`,
      host: `127.0.0.1:${port}`,
      protocol: 'http',
    });
  });

  it.runIf(IPV6)('answers on the IPv6 one as well, where the machine has it', async () => {
    const v6 = await fetch(`http://[::1]:${started().url.port}/echo`);

    expect(v6.status).toBe(200);
  });

  it("asks each app Function as the edge routes a validation's probe of it, on the backstage", async () => {
    const stack = started();
    const asked = (name: string): Promise<Response> =>
      fetch(new URL(`function/${name}?path=${encodeURIComponent('/echo')}`, stack.backstage));

    const first = await asked('app');
    const second = await asked('app-2');

    // Handed on by the edge to the Function named, which is told the middleware ran — under the
    // site's origin where the request names it, which `fetch` cannot (the check's reader does, and
    // its probe arrives so: `checkStack` below fails a probe that does not).
    expect(accountOf(first)).toStrictEqual(['passthrough', 'reason=function-probe', 'fn=app']);
    await expect(first.json()).resolves.toMatchObject({
      deployment: stack.deploymentId,
      done: '1',
    });
    expect(accountOf(second)).toStrictEqual(['passthrough', 'reason=function-probe', 'fn=app-2']);
    await expect(second.json()).resolves.toStrictEqual({ function: 'app-2', done: '1' });
  });

  it('runs a JSON module as the value it parses to', async () => {
    const response = await fetch(new URL('/json', started().url));

    await expect(response.json()).resolves.toStrictEqual(JSON.parse(DATA));
  });

  it('binds a Function as a deploy does: its cache with its token, the read gateway, the bundle reader', async () => {
    const response = await fetch(new URL('/bindings', started().url));

    await expect(response.json()).resolves.toStrictEqual([200, 200, 200]);
  });

  it('binds the stores the application asks for, listed as a deploy lists them, and no store under a name a deploy binds', async () => {
    const stored = await fetch(new URL('/kv', started().url));
    const refused = startStack({
      bundleDir: path.join(state.dir ?? '', OUT_DIR_NAME),
      storage: { kv: ['ARKOR_CACHE'] },
    });

    await expect(stored.json()).resolves.toStrictEqual({
      stored: 'stored',
      listed: '[{"name":"APP_KV","type":"kv_namespace"}]',
    });
    await expect(refused).rejects.toThrow('ARKOR_CACHE cannot be bound to a store');
  });

  it('stamps a nonce and puts it in policies on the backstage, by the edge’s own code', async () => {
    const { backstage } = started();

    const stamped = await fetch(new URL('stamp?nonce=n0nce', backstage), {
      method: 'POST',
      body: '<script>self.a=1</script><link rel="modulepreload" href="/a.js"><p>kept</p>',
    });
    const nonced = await fetch(new URL('nonced?nonce=n0nce&mode=enforce&strict=1', backstage), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'content-security-policy': "script-src 'self'" }),
    });

    await expect(stamped.text()).resolves.toBe(
      '<script nonce="n0nce">self.a=1</script><link rel="modulepreload" href="/a.js" nonce="n0nce"><p>kept</p>',
    );
    await expect(nonced.json()).resolves.toStrictEqual({
      'content-security-policy': "script-src 'self' 'nonce-n0nce' 'strict-dynamic'",
    });
  });

  it('stamps a document again on the backstage as the edge stamps one: the same, where the edge stamped it throughout', async () => {
    const { backstage } = started();
    const stampOf = async (document: string, nonce: string): Promise<string> => {
      const stamped = await fetch(new URL(`stamp?nonce=${nonce}`, backstage), {
        method: 'POST',
        body: document,
      });
      return stamped.text();
    };
    const restampedOf = async (document: string): Promise<unknown> => {
      const restamped = await fetch(new URL('stamped-digest?nonce=n0nce', backstage), {
        method: 'POST',
        body: document,
      });
      return restamped.json();
    };
    // A shell as a build writes one — its attributes spaced and cased as written, a nonce of the
    // application's own — and what follows it: a script, and a preload of another.
    const shell =
      '<!doctype html><html><head><SCRIPT async  src="/a.js"></SCRIPT><link\n rel="modulepreload" href="/b.js"><style nonce="app">p{}</style></head><body>';
    const script = '<script>self.late=1</script>';
    const preload = '<link rel="preload" as="script" href="/c.js"></body></html>';
    const stampedShell = await stampOf(shell, 'n0nce');
    const throughout = stampedShell + (await stampOf(script + preload, 'n0nce'));
    const lateScript = stampedShell + script + (await stampOf(preload, 'n0nce'));
    const latePreload = stampedShell + (await stampOf(script, 'n0nce')) + preload;
    const stale = stampedShell + (await stampOf(script + preload, 'old'));

    await expect(restampedOf(throughout)).resolves.toStrictEqual(digestOf(throughout));
    await expect(restampedOf(lateScript)).resolves.not.toStrictEqual(digestOf(lateScript));
    await expect(restampedOf(latePreload)).resolves.not.toStrictEqual(digestOf(latePreload));
    await expect(restampedOf(stale)).resolves.not.toStrictEqual(digestOf(stale));
  });

  it('refuses a policy under an id the built-ins hold, but the built-in itself', async () => {
    const bundleDir = path.join(state.dir ?? '', OUT_DIR_NAME);
    const middleware = { ...DEFAULT_DELIVERY_POLICY.middleware, timeoutMs: 1 };
    const altered = startStack({ bundleDir, policy: { ...DEFAULT_DELIVERY_POLICY, middleware } });
    const taken = startStack({ bundleDir, policy: { ...DEFAULT_DELIVERY_POLICY, id: 'paas-v99' } });

    await expect(altered).rejects.toThrow(
      'paas-v5 is an id the built-in policies hold, which no other policy may',
    );
    await expect(taken).rejects.toThrow(
      'paas-v99 is an id the built-in policies hold, which no other policy may',
    );
  });

  it('names the site at its socket, and no port where the scheme has it', () => {
    expect(siteUrlOf(new URL('http://127.0.0.1:8787')).href).toBe('http://localhost:8787/');
    expect(siteUrlOf(new URL('http://127.0.0.1:80')).href).toBe('http://localhost/');
  });

  it('refuses a delivery policy that reads shells from Static Assets, which it binds none of', async () => {
    const refused = startStack({
      bundleDir: path.join(state.dir ?? '', OUT_DIR_NAME),
      policy: {
        ...DEFAULT_DELIVERY_POLICY,
        id: 'assets-shells',
        shell: { ...DEFAULT_DELIVERY_POLICY.shell, backend: 'static-assets' },
      },
    });

    await expect(refused).rejects.toThrow(
      'assets-shells serves shells from a Static Assets binding, and a stack binds none',
    );
  });

  it('serves the build’s files from the bucket, as its check finds', async () => {
    const stack = started();

    const asset = await fetch(new URL(ASSET_PATH, stack.url));
    const checked = await checkStack(stack);

    expect(asset.headers.get('cache-control')).toContain('immutable');
    await expect(asset.text()).resolves.toBe(ASSET);
    // The asset — and again with the deployment's id, as a document of the build names it — and each
    // app Function asked for a miss through the edge, under the site's origin.
    expect(stack.functions).toStrictEqual(['app', 'app-2']);
    expect(stack.manifest.deployment.dplId).toBe(stack.deploymentId);
    expect(checked).toStrictEqual({ checked: 4, failures: [], skipped: [] });
  });
});
