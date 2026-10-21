import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { EdgeHost } from '../src/edge-host.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite, type SiteOptions } from './helpers/site.ts';

/**
 * The application's rules, judged on what its routing is handed: never the host's own credentials
 * (`HostCredentials`). Composed as a host composes the edge (`serveFromPointer`), with credentials
 * of its own, which the standalone host keeps none of.
 */

/** A rule's pattern over every path. */
const EVERY_PATH = String.raw`^(?:\/(.*))(?:\/)?$`;

/** The standalone host, keeping the `cookie` header whole, and naming no cookie of its own. */
function cookielessHost(): EdgeHost {
  return { ...standaloneHost(env), credentials: { cookies: [], headers: ['Cookie'] } };
}

/** `request` answered by `host`, the site seeded as `site` says, its Function answering. */
async function answered(
  request: IncomingRequest,
  site: Omit<SiteOptions, 'document'> & { readonly staticPage?: boolean },
  host: EdgeHost,
): Promise<Response> {
  const { pointer, manifest: seeded } = await seedSite({ document: pprDocument(), ...site });
  const manifest =
    site.staticPage === true
      ? buildProjectManifest({
          projectId: seeded.projectId,
          runId: seeded.runId,
          generatedAt: seeded.generatedAt,
          originHost: pointer.originHost,
          deployment: seeded.deployment,
          app: seeded.app,
          routes: Object.values(seeded.routes).map((route): RouteEntry => {
            return {
              ...route,
              cache: { entryId: 'static-entry', kind: 'pages', delivery: 'complete' },
            };
          }),
          cache: { scopeId: 'static-scope', keySchemaVersion: 1 },
          staticPages: [{ pathname: '/', route: '/', entryId: 'static-entry' }],
        })
      : seeded;
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: () => Promise.resolve(new Response('from the Function')),
  });
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime,
      host,
      pointer,
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
  await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return response;
}

describe("the headers an application's rules are judged on", () => {
  it.each(['Authorization', 'Proxy-Authorization', 'If-None-Match'])(
    'removes host-owned %s before static-page privacy classification',
    async (header) => {
      const host = { ...standaloneHost(env), credentials: { cookies: [], headers: [header] } };
      const response = await answered(
        navigation('/', { headers: { [header]: 'host-secret' } }),
        { staticPage: true },
        host,
      );

      // This Edge version forwards static-page classes; this verifies classification, not a cache hit.
      expect(response.headers.get('x-arkor-edge')).toMatch(
        /^passthrough;reason=static-page(?:;|$)/u,
      );
    },
  );

  it.each(['Authorization', 'Proxy-Authorization', 'If-None-Match'])(
    'keeps application-visible %s private for static-page classification',
    async (header) => {
      const response = await answered(
        navigation('/', { headers: { [header]: 'app-value' } }),
        { staticPage: true },
        standaloneHost(env),
      );

      expect(response.headers.get('x-arkor-edge')).toMatch(
        /^passthrough;reason=static-page-bypass(?:;|$)/u,
      );
    },
  );

  /**
   * A host may keep the `cookie` header whole rather than cookies by name: no cookie reaches the
   * application then, so a `missing` that names one holds for a visitor who sends it, and the
   * rule's headers are what the application's router answers that visitor with.
   */
  it('sets the headers of a rule whose `missing` names a cookie the host keeps the header of', async () => {
    const response = await answered(
      navigation('/', { headers: { cookie: 'theme=dark' } }),
      {
        headerRules: [
          {
            sourceRegex: EVERY_PATH,
            missing: [{ type: 'cookie', key: 'theme' }],
            headers: { 'X-Robots-Tag': 'noindex' },
          },
        ],
      },
      cookielessHost(),
    );

    expect(response.headers.get('x-arkor-edge')).toMatch(/^shell;/u);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
  });
});
