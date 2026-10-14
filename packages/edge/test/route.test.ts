import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { type PointerRequest, serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite, type SiteOptions } from './helpers/site.ts';

/**
 * A host that composes the edge's routing itself (`serveFromPointer`), rather than running the
 * standalone Worker. Nothing in this file runs the standalone Worker, which would bound the tests of
 * the whole isolate for it.
 */

/** Two repetitions that take what the other does: quadratic in the length of what fails them. */
const QUADRATIC = String.raw`^/(?<slug>\w+\w+)!$`;
/** Long enough that the pattern's cost against it is past what a test is allowed. */
const CRAFTED = `/${'a'.repeat(4096)}`;

/** `request` routed by a host of its own, the site seeded as `site` says, its Function answering. */
async function routed(
  request: IncomingRequest,
  site: Omit<SiteOptions, 'document'>,
  composed: Pick<PointerRequest, 'observePassthrough'> = {},
): Promise<{ readonly response: Response; readonly body: string; readonly asked: string[] }> {
  const { pointer } = await seedSite({ document: pprDocument(), ...site });
  const asked: string[] = [];
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (_scriptName: string, dispatched: Request): Promise<Response> => {
      asked.push(new URL(dispatched.url).pathname);
      return Promise.resolve(new Response('from the Function'));
    },
  });
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
    ...composed,
  });
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body, asked };
}

describe('the routing a host composes', () => {
  /**
   * Every test of an application's routing pattern is bounded all the same: one that would cost
   * more against the request than a test is allowed is not run, and the request goes to the
   * application's Function.
   */
  it('hands a request a pattern would cost too much to test to the Function', async () => {
    const { response, body, asked } = await routed(navigation(CRAFTED), {
      dynamicRoutes: [{ sourceRegex: QUADRATIC, route: '/[slug]' }],
    });

    expect(response.headers.get('x-arkor-edge')).toBe('passthrough;reason=pattern-budget');
    expect(body).toBe('from the Function');
    expect(asked).toStrictEqual([CRAFTED]);
  });

  /** The host's observer of a passthrough is the host's own code: what it throws changes no answer. */
  it('answers a passthrough whose observer throws as the Function answered it', async () => {
    const throwing = {
      observePassthrough: () => {
        return {
          body: undefined,
          finish: (): void => {
            throw new Error('the observer broke');
          },
        };
      },
    };

    const { response, body } = await routed(navigation('/api/hello'), {}, throwing);

    expect(response.status).toBe(200);
    expect(body).toBe('from the Function');
  });
});
