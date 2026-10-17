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
  site: Omit<SiteOptions, 'document'>,
  host: EdgeHost,
): Promise<Response> {
  const { pointer } = await seedSite({ document: pprDocument(), ...site });
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: () => Promise.resolve(new Response('from the Function')),
  });
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
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
  });
  await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return response;
}

describe("the headers an application's rules are judged on", () => {
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
