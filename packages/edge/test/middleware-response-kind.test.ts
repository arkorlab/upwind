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
import { encodeUtf8 } from '@stayingupwind/core/util';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
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

interface Example {
  readonly member?: boolean;
  readonly incoming?: 'payload' | 'segment';
  readonly added?: 'payload' | 'segment' | 'ordinary' | 'nominated' | 'credential';
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

async function answered(example: Example) {
  const document = pprDocument();
  const member = example.member === true;
  const site = await seedSite({
    document,
    pathname: member ? '/unrelated' : '/',
    segments: { [SEGMENT]: FLIGHT },
    dynamicRoutes: member
      ? [{ sourceRegex: '^/member$', members: { route: '/[slug]', kind: 'app-page' } }]
      : undefined,
  });
  const scopeId = `kind-${crypto.randomUUID()}`;
  if (member) await keepMember(document, scopeId);
  const entry = site.manifest.routes['/'];
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
    ...(member && { cache: { keySchemaVersion: 1, scopeId } }),
    ...(!member &&
      entry !== undefined && {
        routes: { ...site.manifest.routes, '/': { ...entry, payload: entry.segments?.[SEGMENT] } },
      }),
  };
  const url = member ? `${SITE}member` : SITE;
  const pathname = member ? '/member' : '/';
  const request =
    example.incoming === undefined
      ? navigation(pathname)
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

describe('the response kind after hosted middleware', () => {
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
