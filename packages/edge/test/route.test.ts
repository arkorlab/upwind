import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

/**
 * A host that composes the edge's routing itself (`serveFromPointer`), rather than running the
 * standalone Worker, routes with every test of an application's routing pattern bounded all the
 * same: one that would cost more against the request than a test is allowed is not run, and the
 * request goes to the application's Function. Nothing in this file runs the standalone Worker, which
 * would bound the tests of the whole isolate for it.
 */

/** Two repetitions that take what the other does: quadratic in the length of what fails them. */
const QUADRATIC = String.raw`^/(?<slug>\w+\w+)!$`;
/** Long enough that the pattern's cost against it is past what a test is allowed. */
const CRAFTED = `/${'a'.repeat(4096)}`;

describe('the routing a host composes', () => {
  it('hands a request a pattern would cost too much to test to the Function', async () => {
    const { pointer } = await seedSite({
      document: pprDocument(),
      dynamicRoutes: [{ sourceRegex: QUADRATIC, route: '/[slug]' }],
    });
    const asked: string[] = [];
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: (_scriptName: string, request: Request): Promise<Response> => {
        asked.push(new URL(request.url).pathname);
        return Promise.resolve(new Response('from the Function'));
      },
    });
    const request = navigation(CRAFTED);
    const ctx = createExecutionContext();

    const response = await serveFromPointer({
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime,
      host: standaloneHost(env),
      pointer,
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    });
    const body = await response.text();
    await waitOnExecutionContext(ctx);

    expect(response.headers.get('x-arkor-edge')).toBe('passthrough;reason=pattern-budget');
    expect(body).toBe('from the Function');
    expect(asked).toStrictEqual([CRAFTED]);
  });
});
