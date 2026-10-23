import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { handlePassthrough } from '../src/handlers/passthrough.ts';
import { dispatchesMade, dispatchesOfFailure, fetchUpstream } from '../src/handlers/upstream.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import type { RouteReport } from '../src/reports.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const APP = { deploymentId: 'dpl_dispatch', scriptName: 'dispatch-app' };

describe('synchronous application dispatch failures', () => {
  it('returns an ordinary single-Function promise without wrapping it', async () => {
    const pending = Promise.withResolvers<Response>();
    const runtime = standaloneRuntime(env, { dispatchApp: () => pending.promise });
    const answer = fetchUpstream(runtime, APP, new Request('https://site.example/'));

    expect(answer).toBe(pending.promise);
    expect(dispatchesMade(answer)).toBe(1);

    pending.resolve(new Response('ordinary'));

    await expect((await answer).text()).resolves.toBe('ordinary');
  });

  it.each([false, true])('keeps the rejection and sent count when split=%s', async (split) => {
    const failure = new Error('dispatch threw before returning a promise');
    const runtime = standaloneRuntime(env, {
      dispatchApp: () => {
        throw failure;
      },
    });
    const app = { ...APP, ...(split && { functions: { 'app-2': 'dispatch-app-2' } }) };
    // The public contract returns a promise even when the host call itself throws.
    const answer = fetchUpstream(runtime, app, new Request('https://site.example/'));

    await expect(answer).rejects.toBe(failure);
    expect(dispatchesMade(answer)).toBe(1);
    expect(dispatchesOfFailure(failure)).toBe(1);
  });

  it.each([false, true])('uses normal passthrough handling when gone=%s', async (gone) => {
    const failure = new Error('the dispatched Worker is unavailable');
    const points: EdgeMetric[] = [];
    const classified: unknown[] = [];
    const host = standaloneHost(env);
    let retried = 0;
    const response = await handlePassthrough({
      request: new Request('https://site.example/api'),
      forwarding: { previewDomain: 'example', previewHost: 'site.example', clientIp: undefined },
      app: APP,
      runtime: standaloneRuntime(env, {
        dispatchApp: () => {
          throw failure;
        },
      }),
      host: {
        ...host,
        functionGone: (error) => {
          classified.push(error);
          return gone;
        },
        observer: {
          ...host.observer,
          metric: (point) => {
            points.push(point);
          },
        },
      },
      whenGone: () => {
        retried += 1;
        return Promise.resolve(new Response('replacement'));
      },
      reason: 'route-not-proved',
      metrics: {
        projectId: 'site',
        manifestId: 'manifest',
        policyId: 'policy',
        pathname: '/api',
        colo: '',
        storageReads: 3,
        resumeDispatches: 2,
        assetDispatches: 1,
      },
    });

    expect(response.status).toBe(gone ? 200 : 502);
    expect(classified).toStrictEqual([failure]);
    expect(retried).toBe(gone ? 1 : 0);
    expect(points).toHaveLength(1);
    expect(points[0]?.subrequests).toBe(7);
    expect(points[0]?.redispatch).toBe(0);

    const body = await response.text();

    expect(body).toContain(gone ? 'replacement' : 'The application could not be reached');
  });

  it('contains the failure after a public document continuation starts', async () => {
    const document = pprDocument();
    const site = await seedSite({ document });
    const points: EdgeMetric[] = [];
    const reports: RouteReport[] = [];
    const host = standaloneHost(env);
    const request = navigation('/');
    const ctx = createExecutionContext();
    const response = await serveFromPointer({
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime: standaloneRuntime(env, {
        memory: createEdgeMemory(() => Date.now()),
        dispatchApp: () => {
          throw new Error('the continuation dispatch threw');
        },
        reports: {
          report: (report) => {
            reports.push(report);
          },
        },
      }),
      host: {
        ...host,
        observer: {
          ...host.observer,
          metric: (point) => {
            points.push(point);
          },
        },
      },
      pointer: site.pointer,
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    });
    const body = await response.text();
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(body).toContain('Loading');
    expect(points).toHaveLength(1);
    expect(points[0]?.outcomeKind).toBe('upstream-error');
    expect(points[0]?.subrequests).toBe(2);
    expect(reports.some((report) => report.kind === 'continuation-failure')).toBe(true);
  });
});
