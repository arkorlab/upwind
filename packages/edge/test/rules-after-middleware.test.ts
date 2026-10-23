import { sha256Hex } from '@stayingupwind/core/artifact';
import type { ImagesConfig } from '@stayingupwind/core/images';
import type {
  HeaderRule,
  ProjectManifest,
  ReservedRoute,
  StaticFileEntry,
} from '@stayingupwind/core/manifest';
import {
  HEADER_RULES_JUDGED_HEADER,
  HEADER_RULES_LEFT_HEADER,
  MIDDLEWARE_DONE_HEADER,
} from '@stayingupwind/core/paas';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

/**
 * A request the middleware changed — rewrote, or handed on with other headers — is routed again as
 * it left it (Codex): Next.js's router runs its `beforeFiles` rewrites after the middleware, so a
 * rule that claims the optimizer's request or a shipped file's as the middleware left it makes the
 * Worker's answer the response; a rule that claims neither leaves the edge to answer.
 */

const HOST = 'site.example';
const DPL = 'dpl_site';
const CONFIG: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  dangerouslyAllowLocalIP: false,
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};

/** A PNG signature and a payload of its own, which the test transformer passes through. */
function png(text: string): Uint8Array {
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encodeUtf8(text),
  ]);
}

async function store(bytes: Uint8Array, contentType: string): Promise<StaticFileEntry> {
  const sha256 = await sha256Hex(bytes);
  await env.ARTIFACTS.put(blobObjectKey(sha256), bytes);
  return { sha256, byteLength: bytes.byteLength, contentType, immutable: false, deploymentId: DPL };
}

function escaped(pathname: string): string {
  return pathname.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

/** Two shipped files the cases name, each holding bytes of its own. */
interface Paths {
  readonly first: string;
  readonly second: string;
}

interface Case {
  /** What the path the request is for is, and what the middleware covers. */
  readonly kind: 'optimizer' | 'file';
  /** What the middleware answers, given the files' paths. */
  readonly middleware: (paths: Paths) => Response;
  /** The rules ahead of the filesystem, given the same paths. */
  readonly reserved: (paths: Paths) => readonly ReservedRoute[];
  /** The header rules of `next.config`, judged on the request as the client sent it. */
  readonly headerRules?: readonly HeaderRule[];
}

function optimizerUrl(source: string): string {
  const query = new URLSearchParams({ url: source, w: '64', q: '75', dpl: DPL });
  return `https://${HOST}/_next/image?${query.toString()}`;
}

/** The request the case makes, through the edge, and what was asked of the application's Worker. */
async function answered(example: Case) {
  const extension = example.kind === 'optimizer' ? 'png' : 'txt';
  const paths: Paths = {
    first: `/files/${crypto.randomUUID()}.${extension}`,
    second: `/files/${crypto.randomUUID()}.${extension}`,
  };
  const stored =
    example.kind === 'optimizer'
      ? { first: png(`stored at ${paths.first}`), second: png(`stored at ${paths.second}`) }
      : {
          first: encodeUtf8(`stored at ${paths.first}`),
          second: encodeUtf8(`stored at ${paths.second}`),
        };
  const type = example.kind === 'optimizer' ? 'image/png' : 'text/plain';
  const fromWorker = encodeUtf8('the Worker answered');
  const site = await seedSite({ document: pprDocument(), images: CONFIG });
  const [first, second] = await Promise.all([
    store(stored.first, type),
    store(stored.second, type),
  ]);
  const manifest: ProjectManifest = {
    ...site.manifest,
    deployment: { ...site.manifest.deployment, dplId: DPL },
    middleware: {
      matchers: [{ sourceRegex: example.kind === 'optimizer' ? '^/_next/image' : '^/files/' }],
    },
    staticFiles: { [paths.first]: first, [paths.second]: second },
    reservedRoutes: [...example.reserved(paths)],
    ...(example.headerRules !== undefined && {
      // `headers()` of `next.config`, which Next.js puts ahead of the middleware, unless one says.
      headerRules: example.headerRules.map((rule) => ({ phase: 'beforeMiddleware', ...rule })),
      // Every rule is in the manifest, so the edge judges them for the Worker it hands on to.
      dynamicRoutes: [],
    }),
  };
  const asked: { readonly script: string; readonly request: Request }[] = [];
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (script, request) => {
      asked.push({ script, request });
      // As the runtime answers a request whose rules the edge judged: it leaves them to the edge.
      const judged = request.headers.get(HEADER_RULES_JUDGED_HEADER) === '1';
      return Promise.resolve(
        script === 'site-middleware'
          ? example.middleware(paths)
          : new Response(fromWorker, {
              headers: {
                'content-type': 'text/plain',
                ...(judged && { [HEADER_RULES_LEFT_HEADER]: '1' }),
              },
            }),
      );
    },
    transformImage: async (body) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      return {
        contentType: 'image/webp',
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    },
  });
  const request = new Request<unknown, IncomingRequestCfProperties>(
    example.kind === 'optimizer' ? optimizerUrl(paths.first) : `https://${HOST}${paths.first}`,
    {
      headers:
        example.kind === 'optimizer'
          ? { accept: 'image/webp', 'sec-fetch-dest': 'image' }
          : { accept: '*/*' },
    },
  );
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime,
      host: standaloneHost(env),
      pointer: {
        ...site.pointer,
        app: { deploymentId: DPL, scriptName: 'site-app', middlewareScriptName: 'site-middleware' },
      },
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
      policyLookup: Promise.resolve({
        kind: 'found',
        source: 'exact',
        policy: DEFAULT_DELIVERY_POLICY,
      }),
    },
  );
  const body = new Uint8Array(await response.arrayBuffer());
  await waitOnExecutionContext(ctx);
  const worker = asked.filter((one) => one.script === 'site-app').map((one) => one.request);
  return { response, body, stored, fromWorker, paths, worker };
}

/** The optimizer's request for the second file in place of the first. */
function optimizingSecond(paths: Paths): Response {
  return new Response(null, { headers: { 'x-middleware-rewrite': optimizerUrl(paths.second) } });
}

/** The request for a path no file of the build is at, in place of the first. */
function rewritingAway(): Response {
  return new Response(null, {
    headers: { 'x-middleware-rewrite': `https://${HOST}/elsewhere` },
  });
}

/** The request for the second file in place of the first. */
function rewritingToSecond(paths: Paths): Response {
  return new Response(null, {
    headers: { 'x-middleware-rewrite': `https://${HOST}${paths.second}` },
  });
}

function variant(value: string): () => Response {
  return () => {
    return new Response(null, {
      headers: {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'x-variant',
        'x-middleware-request-x-variant': value,
      },
    });
  };
}

/** Claims the optimizer's request for `source`, before the filesystem. */
function claimingOptimizerFor(source: string): readonly ReservedRoute[] {
  return [
    {
      sourceRegex: '^/_next/image$',
      beforeFiles: true,
      has: [{ type: 'query', key: 'url', value: escaped(source) }],
    },
  ];
}

/** Claims `pathname` for a request carrying `x-variant: b`, before the filesystem. */
function claimingVariantOf(pathname: string): readonly ReservedRoute[] {
  return [
    {
      sourceRegex: `^${escaped(pathname)}$`,
      beforeFiles: true,
      has: [{ type: 'header', key: 'x-variant', value: 'b' }],
    },
  ];
}

/** Claims `pathname`, before the filesystem. */
function claiming(pathname: string): readonly ReservedRoute[] {
  return [{ sourceRegex: `^${escaped(pathname)}$`, beforeFiles: true }];
}

describe('an optimizer request the middleware changed, routed as it left it', () => {
  it('asks the Worker for a rewrite onto the optimizer that a rule claims', async () => {
    const result = await answered({
      kind: 'optimizer',
      middleware: optimizingSecond,
      reserved: (paths) => claimingOptimizerFor(paths.second),
    });

    expect(result.body).toStrictEqual(result.fromWorker);
    expect(result.worker).toHaveLength(1);
    expect(result.worker[0]?.headers.get(MIDDLEWARE_DONE_HEADER)).toBe('1');
  });

  it('optimizes the source a rewrite names where no rule claims it', async () => {
    const result = await answered({
      kind: 'optimizer',
      middleware: optimizingSecond,
      reserved: (paths) => claimingOptimizerFor(`${paths.second}-elsewhere`),
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toStrictEqual(result.stored.second);
    expect(result.worker).toStrictEqual([]);
  });

  it('asks the Worker for a request whose headers it changed into one a rule claims', async () => {
    const result = await answered({
      kind: 'optimizer',
      middleware: variant('b'),
      reserved: () => claimingVariantOf('/_next/image'),
    });

    expect(result.body).toStrictEqual(result.fromWorker);
    expect(result.worker).toHaveLength(1);
    expect(result.worker[0]?.headers.get('x-variant')).toBe('b');
    expect(result.worker[0]?.headers.get(MIDDLEWARE_DONE_HEADER)).toBe('1');
  });

  it('optimizes the source where the headers it changed leave the request unclaimed', async () => {
    const result = await answered({
      kind: 'optimizer',
      middleware: variant('a'),
      reserved: () => claimingVariantOf('/_next/image'),
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toStrictEqual(result.stored.first);
    expect(result.worker).toStrictEqual([]);
  });
});

describe('a shipped file the middleware changed, routed as it left it', () => {
  it('asks the Worker for a rewrite onto a shipped file that a rule claims', async () => {
    const result = await answered({
      kind: 'file',
      middleware: rewritingToSecond,
      reserved: (paths) => claiming(paths.second),
    });

    expect(result.body).toStrictEqual(result.fromWorker);
    expect(result.worker).toHaveLength(1);
    expect(new URL(result.worker[0]?.url ?? '').pathname).toBe(result.paths.second);
    expect(result.worker[0]?.headers.get(MIDDLEWARE_DONE_HEADER)).toBe('1');
  });

  it('serves the file a rewrite lands on where no rule claims it', async () => {
    const result = await answered({
      kind: 'file',
      middleware: rewritingToSecond,
      reserved: (paths) => claiming(`${paths.second}-elsewhere`),
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toStrictEqual(result.stored.second);
    expect(result.worker).toStrictEqual([]);
  });

  it('asks the Worker for a file whose headers it changed into a request a rule claims', async () => {
    const result = await answered({
      kind: 'file',
      middleware: variant('b'),
      reserved: (paths) => claimingVariantOf(paths.first),
    });

    expect(result.body).toStrictEqual(result.fromWorker);
    expect(result.worker).toHaveLength(1);
    expect(new URL(result.worker[0]?.url ?? '').pathname).toBe(result.paths.first);
    expect(result.worker[0]?.headers.get('x-variant')).toBe('b');
  });

  it('serves the file where the headers it changed leave the request unclaimed', async () => {
    const result = await answered({
      kind: 'file',
      middleware: variant('a'),
      reserved: (paths) => claimingVariantOf(paths.first),
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toStrictEqual(result.stored.first);
    expect(result.worker).toStrictEqual([]);
  });
});

/** A CORS allowance `next.config` gives every request on the path the client asked for. */
function allowing(sourceRegex: string): readonly HeaderRule[] {
  return [{ sourceRegex, headers: { 'access-control-allow-origin': '*' } }];
}

describe('a request the middleware changed and a rule claims, handed on under its own rules', () => {
  it.each([
    {
      label: 'a file whose headers it changed',
      example: {
        kind: 'file',
        middleware: variant('b'),
        reserved: (paths: Paths) => claimingVariantOf(paths.first),
        headerRules: allowing('^/files/.*$'),
      },
    },
    {
      label: 'a file it rewrote onto another',
      example: {
        kind: 'file',
        middleware: rewritingToSecond,
        reserved: (paths: Paths) => claiming(paths.second),
        headerRules: allowing('^/files/.*$'),
      },
    },
    {
      label: 'an optimizer request whose headers it changed',
      example: {
        kind: 'optimizer',
        middleware: variant('b'),
        reserved: () => claimingVariantOf('/_next/image'),
        headerRules: allowing('^/_next/image$'),
      },
    },
    {
      label: 'an optimizer request it rewrote onto another',
      example: {
        kind: 'optimizer',
        middleware: optimizingSecond,
        reserved: (paths: Paths) => claimingOptimizerFor(paths.second),
        headerRules: allowing('^/_next/image$'),
      },
    },
  ] as const)(
    'tells the Worker its rules were judged, and lays them: $label',
    async ({ example }) => {
      const result = await answered(example);

      expect(result.body).toStrictEqual(result.fromWorker);
      expect(result.worker).toHaveLength(1);
      expect(result.worker[0]?.headers.get(HEADER_RULES_JUDGED_HEADER)).toBe('1');
      expect(result.response.headers.get('access-control-allow-origin')).toBe('*');
    },
  );
});

/**
 * A rule that runs on a match (`onMatch`) — `next build` gives its own assets the year-long
 * `Cache-Control` so — judged by Next.js on the request as it is finally matched: never on what a
 * Function answers in place of the file asked for.
 */
const ON_MATCH_IMMUTABLE: HeaderRule = {
  sourceRegex: '^/files/.*$',
  headers: { 'cache-control': 'public,max-age=31536000,immutable' },
  phase: 'onMatch',
};

describe('the rules handed on beside a request the middleware moved', () => {
  it('carries the rules ahead of the middleware, and none that runs on a match', async () => {
    const result = await answered({
      kind: 'file',
      middleware: rewritingAway,
      reserved: () => [],
      headerRules: [...allowing('^/files/.*$'), ON_MATCH_IMMUTABLE],
    });

    expect(result.body).toStrictEqual(result.fromWorker);
    expect(result.worker).toHaveLength(1);
    expect(result.worker[0]?.headers.get(HEADER_RULES_JUDGED_HEADER)).toBe('1');
    expect(result.response.headers.get('access-control-allow-origin')).toBe('*');
    expect(result.response.headers.get('cache-control')).not.toContain('immutable');
  });

  it('judges nothing for the Function where a rule says no phase', async () => {
    const result = await answered({
      kind: 'file',
      middleware: rewritingAway,
      reserved: () => [],
      headerRules: [
        { ...allowing('^/files/.*$')[0], phase: undefined } as HeaderRule,
        { ...ON_MATCH_IMMUTABLE, phase: undefined },
      ],
    });

    // The Function judges every rule itself, as it did before rules said their phase.
    expect(result.body).toStrictEqual(result.fromWorker);
    expect(result.worker).toHaveLength(1);
    expect(result.worker[0]?.headers.get(HEADER_RULES_JUDGED_HEADER)).toBeNull();
    expect(result.response.headers.get('cache-control')).not.toContain('immutable');
  });
});
