import type { ProjectManifest, StaticFileEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory, rewriteSeenKey } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const PATH = '/report.pdf';
const CURRENT = '%PDF-1.7 the current report';
const PREVIOUS = '%PDF-1.7 the previous report';
const OLD_DPL = 'dpl_previous';
const CURRENT_DPL = 'dpl_current';
const CLASS = '/[...slug]';
type Build = 'current' | 'shared' | 'kept' | 'dpl-only';

/** The real stored bytes, with the same deployment fields the deployer puts in a file entry. */
function fileFor(
  build: Build,
  current: StaticFileEntry,
  previous: StaticFileEntry,
): StaticFileEntry {
  if (build === 'kept' || build === 'dpl-only') {
    return {
      ...previous,
      contentType: 'application/pdf',
      deploymentId: OLD_DPL,
      ...(build === 'dpl-only' && { dplOnly: true }),
    };
  }
  return {
    ...current,
    contentType: 'application/pdf',
    ...(build === 'shared' && {
      previous: { ...previous, contentType: 'application/pdf', deploymentId: OLD_DPL },
    }),
  };
}

async function rewrittenReport(build: Build) {
  const document = pprDocument('the catch-all completion');
  const site = await seedSite({
    document,
    pathname: CLASS,
    files: { [PATH]: CURRENT, '/previous.pdf': PREVIOUS },
    dynamicRoutes: [{ sourceRegex: '^/(.+)$', route: CLASS }],
  });
  const current = site.manifest.staticFiles?.[PATH];
  const previous = site.manifest.staticFiles?.['/previous.pdf'];
  if (current === undefined || previous === undefined) {
    throw new Error('both reports must be stored in the fixture');
  }
  const manifest: ProjectManifest = {
    ...site.manifest,
    deployment: { ...site.manifest.deployment, dplId: CURRENT_DPL },
    middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
    staticFiles: { [PATH]: fileFor(build, current, previous) },
  };
  // Keep the navigation's pin valid while the rewritten file also carries a previous build.
  const request = navigation(build === 'shared' ? `/download?dpl=${CURRENT_DPL}` : '/download');
  const ctx = createExecutionContext();
  const memory = createEdgeMemory(() => Date.now());
  const dispatched: string[] = [];
  try {
    const response = await serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        runtime: standaloneRuntime(env, {
          memory,
          dispatchApp: (script) => {
            dispatched.push(script);
            const answer =
              script === 'site-middleware'
                ? new Response(null, {
                    headers: { 'x-middleware-rewrite': new URL(PATH, request.url).href },
                  })
                : htmlResponse(document.suffix);
            return Promise.resolve(answer);
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
    const body = await response.text();
    return {
      response,
      body,
      dispatched,
      memo: memory.rewritesSeen.get(rewriteSeenKey(site.manifestId, '/download')),
    };
  } finally {
    // The catch-all shell may have been read ahead of the middleware; it still has an owner.
    await waitOnExecutionContext(ctx);
  }
}

describe('a middleware rewrite onto a shipped file covered by a catch-all page', () => {
  it.each([
    { build: 'current', expected: CURRENT },
    { build: 'shared', expected: CURRENT },
    { build: 'kept', expected: PREVIOUS },
  ] as const)('serves the eligible $build file before the dynamic page', async (example) => {
    const result = await rewrittenReport(example.build);

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('content-type')).toBe('application/pdf');
    expect(result.body).toBe(example.expected);
    expect(result.dispatched).toStrictEqual(['site-middleware']);
    expect(result.memo).toStrictEqual({ kind: 'unserved' });
  });

  it('leaves an old deployment-only file to the current catch-all route', async () => {
    const result = await rewrittenReport('dpl-only');

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('content-type')).toContain('text/html');
    expect(result.body).toContain('the catch-all completion');
    expect(result.dispatched).toStrictEqual(['site-middleware', 'site-app']);
    expect(result.memo).toStrictEqual({ kind: 'served', route: CLASS, pathname: PATH });
  });
});
