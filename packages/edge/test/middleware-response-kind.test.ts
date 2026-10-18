import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  deriveEntry,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { MIDDLEWARE_ONLY_HEADER } from '@stayingupwind/core/paas';
import { RSC_HEADER } from '@stayingupwind/core/request';
import { encodeUtf8, toHex } from '@stayingupwind/core/util';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const FLIGHT = 'the application Flight answer';
const SEGMENT = '/_tree';
const SITE = 'https://site.example/';
const FILE = 'the shipped file remains available from storage';
const LARGE_LENGTH = 32 * 1024 * 1024 + 1;
const CHUNK = new Uint8Array(64 * 1024).fill(97);

interface Example {
  readonly member?: boolean;
  readonly incoming?: 'payload' | 'segment';
  readonly added?: 'payload' | 'segment' | 'ordinary' | 'nominated' | 'credential';
  readonly rewrite?: 'file' | 'document';
  readonly missing?: boolean;
}

/** A member with complete HTML: the old pre-middleware document choice can actually serve it. */
async function keepMember(document: ReturnType<typeof pprDocument>, scopeId: string) {
  const route = '/[slug]';
  const pathname = '/member';
  const { entryId } = await deriveEntry(scopeId, { kind: 'app-page', route, pathname });
  const html = encodeUtf8(document.shellText + document.suffixText);
  const now = Date.now();
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId,
      entryId,
      generationId: 'gen_member',
      seq: 1,
      revision: 1,
      source: 'runtime',
      kind: 'app-page',
      route,
      pathname,
      cacheTimestamp: now,
      producedAt: now,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
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
  await env.CACHE_STATE.put(kvGenerationKey(scopeId, entryId), bytes);
}

/** Request overrides use the complete list emitted by NextResponse.next({ request: { headers } }). */
function middlewareAnswer(request: Request, example: Example): Response {
  const headers = new Headers({ 'x-middleware-next': '1' });
  if (example.rewrite !== undefined) {
    const pathname = example.rewrite === 'file' ? '/manual.txt' : '/target';
    headers.set('x-middleware-rewrite', new URL(pathname, request.url).href);
  }
  if (example.added === 'nominated') {
    headers.set('connection', RSC_HEADER);
    headers.set(RSC_HEADER, '1');
  } else if (example.added !== undefined) {
    const left = new Headers(request.headers);
    if (example.added === 'ordinary') {
      left.set('x-rendered-for', 'reader');
    } else {
      left.set(RSC_HEADER, '1');
      if (example.added === 'segment') left.set('next-router-segment-prefetch', SEGMENT);
    }
    const names: string[] = [];
    for (const [name, value] of left) {
      names.push(name);
      headers.set(`x-middleware-request-${name}`, value);
    }
    headers.set('x-middleware-override-headers', names.join(','));
  }
  return new Response(null, { headers });
}

/** Only the manifest additions needed by the selected target; every route keeps real shell bytes. */
function routedManifest(
  manifest: ProjectManifest,
  example: Example,
  scopeId: string,
): ProjectManifest {
  const member = example.member === true;
  const entry = manifest.routes['/'];
  const routes = { ...manifest.routes };
  if (!member && entry !== undefined) {
    routes['/'] = { ...entry, payload: entry.segments?.[SEGMENT] };
  }
  if (example.rewrite === 'document' && entry !== undefined) {
    routes['/target'] = { ...entry, pathname: '/target' };
  }
  return {
    ...manifest,
    middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
    ...(member && { cache: { keySchemaVersion: 1, scopeId } }),
    routes,
  };
}

async function answered(example: Example) {
  const document = pprDocument();
  const member = example.member === true;
  const site = await seedSite({
    document,
    pathname: member ? '/unrelated' : '/',
    segments: { [SEGMENT]: FLIGHT },
    ...(example.rewrite === 'file' && { files: { '/manual.txt': FILE } }),
    dynamicRoutes: member
      ? [{ sourceRegex: '^/member$', members: { route: '/[slug]', kind: 'app-page' } }]
      : undefined,
  });
  const scopeId = `kind-${crypto.randomUUID()}`;
  if (member) await keepMember(document, scopeId);
  const manifest = routedManifest(site.manifest, example, scopeId);
  const pathname = member ? '/member' : '/';
  const target = example.missing === true ? '/unproved' : pathname;
  const url = new URL(target, SITE).href;
  const request =
    example.incoming === undefined
      ? navigation(target)
      : new Request<unknown, IncomingRequestCfProperties>(url, {
          headers: {
            [RSC_HEADER]: '1',
            ...(example.incoming === 'segment' && { 'next-router-segment-prefetch': SEGMENT }),
          },
        });
  const calls: { readonly middleware: boolean; readonly rsc: string | null }[] = [];
  const host = standaloneHost(env);
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime: standaloneRuntime(env, {
        memory: createEdgeMemory(() => Date.now()),
        dispatchApp: (_script, handed) => {
          const middleware = handed.headers.get(MIDDLEWARE_ONLY_HEADER) === '1';
          calls.push({ middleware, rsc: handed.headers.get(RSC_HEADER) });
          if (middleware) return Promise.resolve(middlewareAnswer(handed, example));
          if (new URL(handed.url).pathname === '/manual.txt') {
            return Promise.resolve(
              new Response('the Function has no shipped file', { status: 404 }),
            );
          }
          return Promise.resolve(
            handed.headers.get(RSC_HEADER) === '1'
              ? new Response(FLIGHT, { headers: { 'content-type': 'text/x-component' } })
              : htmlResponse(document.suffix),
          );
        },
      }),
      host:
        example.added === 'credential'
          ? {
              ...host,
              credentials: {
                ...host.credentials,
                headers: [...host.credentials.headers, RSC_HEADER],
              },
            }
          : host,
      pointer: {
        ...site.pointer,
        app: {
          deploymentId: 'dpl_site',
          scriptName: 'site-app',
          middlewareScriptName: 'site-middleware',
        },
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
        policy: member
          ? {
              ...DEFAULT_DELIVERY_POLICY,
              runtimeCache: {
                ...DEFAULT_RUNTIME_CACHE_SETTINGS,
                generations: 'on',
                cacheApiMaxAgeMs: 0,
              },
            }
          : DEFAULT_DELIVERY_POLICY,
      }),
    },
  );
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body, calls, document };
}

/** Reuse one small chunk for hashing and upload; keep no whole-file buffer in the fixture. */
async function fillLargeFile(writer: WritableStreamDefaultWriter<Uint8Array>) {
  for (let offset = 0; offset < LARGE_LENGTH; offset += CHUNK.byteLength) {
    const remaining = LARGE_LENGTH - offset;
    await writer.write(remaining < CHUNK.byteLength ? CHUNK.subarray(0, remaining) : CHUNK);
  }
  await writer.close();
}

async function keepLargeFile() {
  const digest = new crypto.DigestStream('SHA-256');
  const hashing = digest.getWriter();
  try {
    await fillLargeFile(hashing);
  } finally {
    hashing.releaseLock();
  }
  const sha256 = toHex(new Uint8Array(await digest.digest));
  const stream = new FixedLengthStream(LARGE_LENGTH);
  const putting = env.ARTIFACTS.put(blobObjectKey(sha256), stream.readable);
  // Observe an early rejection before writing; await the original put to preserve its error.
  const observedPut = Promise.allSettled([putting]);
  const writer = stream.writable.getWriter();
  try {
    await fillLargeFile(writer);
    await putting;
  } catch (error) {
    await Promise.allSettled([writer.abort(error), putting]);
    throw error;
  } finally {
    await observedPut;
    writer.releaseLock();
  }
  return {
    sha256,
    byteLength: LARGE_LENGTH,
    contentType: 'application/octet-stream',
    immutable: false,
  };
}

async function digestFile(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const digest = new crypto.DigestStream('SHA-256');
  const writer = digest.getWriter();
  let byteLength = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      byteLength += item.value.byteLength;
      await writer.write(item.value);
    }
    await writer.close();
    return { byteLength, sha256: toHex(new Uint8Array(await digest.digest)) };
  } catch (error) {
    await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
    throw error;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

async function largeRewrittenFile() {
  const file = await keepLargeFile();
  const site = await seedSite({ document: pprDocument() });
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
    staticFiles: { '/manual.txt': file },
  };
  const request = navigation('/');
  const calls: boolean[] = [];
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime: standaloneRuntime(env, {
        memory: createEdgeMemory(() => Date.now()),
        dispatchApp: (_script, handed) => {
          const middleware = handed.headers.get(MIDDLEWARE_ONLY_HEADER) === '1';
          calls.push(middleware);
          return Promise.resolve(
            middleware
              ? middlewareAnswer(handed, { rewrite: 'file', added: 'payload' })
              : new Response('the Function has no shipped file', { status: 404 }),
          );
        },
      }),
      host: standaloneHost(env),
      pointer: {
        ...site.pointer,
        app: {
          deploymentId: 'dpl_site',
          scriptName: 'site-app',
          middlewareScriptName: 'site-middleware',
        },
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
  try {
    if (response.body === null) throw new Error('the shipped file has no body');
    const actual = await digestFile(response.body);
    return { response, actual, file, calls };
  } finally {
    try {
      await waitOnExecutionContext(ctx);
    } finally {
      await env.ARTIFACTS.delete(blobObjectKey(file.sha256));
    }
  }
}

describe('the response kind after hosted middleware', () => {
  it('streams an actual file above the Function buffer ceiling after a Flight rewrite', async () => {
    const result = await largeRewrittenFile();

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('content-length')).toBe(String(LARGE_LENGTH));
    expect(result.actual).toStrictEqual({ byteLength: LARGE_LENGTH, sha256: result.file.sha256 });
    expect(result.calls).toStrictEqual([true]);
  }, 30_000);

  it.each([
    { added: 'payload' },
    { added: 'segment' },
    { added: 'payload', missing: true },
    {},
    { incoming: 'payload' },
  ] as const)(
    'keeps a shipped-file rewrite ahead of Flight handling: %j',
    async (example: Example) => {
      const result = await answered({ ...example, rewrite: 'file' });

      expect(result.response.status).toBe(200);
      expect(result.body).toBe(FILE);
      expect(result.calls).toStrictEqual([
        { middleware: true, rsc: example.incoming === 'payload' ? '1' : null },
      ]);
    },
  );

  it('hands an actual rewritten document changed to Flight to the Function', async () => {
    const result = await answered({ rewrite: 'document', added: 'payload' });

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('content-type')).toBe('text/x-component');
    expect(result.body).toBe(FLIGHT);
    expect(result.calls).toStrictEqual([
      { middleware: true, rsc: null },
      { middleware: false, rsc: '1' },
    ]);
  });

  it.each([
    { added: 'payload' },
    { added: 'segment' },
    { member: true, added: 'payload' },
  ] as const)('hands a navigation changed to Flight to the Function: %j', async (example) => {
    const result = await answered(example);

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('content-type')).toBe('text/x-component');
    expect(result.body).toBe(FLIGHT);
    expect(result.calls).toStrictEqual([
      { middleware: true, rsc: null },
      { middleware: false, rsc: '1' },
    ]);
  });

  it.each([undefined, 'ordinary', 'nominated', 'credential'] as const)(
    'keeps HTML when the Function receives no Flight request: %s',
    async (added) => {
      const result = await answered({ ...(added !== undefined && { added }) });

      expect(result.response.status).toBe(200);
      expect(result.response.headers.get('content-type')).toContain('text/html');
      expect(result.body).toContain(result.document.shellText);
      expect(result.calls).toStrictEqual([
        { middleware: true, rsc: null },
        { middleware: false, rsc: null },
      ]);
    },
  );

  it.each(['payload', 'segment'] as const)(
    'keeps an existing %s request as the stored router answer',
    async (incoming) => {
      const result = await answered({ incoming });

      expect(result.response.status).toBe(200);
      expect(result.response.headers.get('content-type')).toBe('text/x-component');
      expect(result.body).toBe(FLIGHT);
      expect(result.calls).toStrictEqual([{ middleware: true, rsc: '1' }]);
    },
  );
});
