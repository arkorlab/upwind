import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  deriveEntry,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
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
import type { EdgeMetric } from '../src/observability/metrics.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

/**
 * A member's Flight payload whose own record names a part storage no longer holds is handed to the
 * Function as the member is, with what the part's fallback carries (Sentry): the read of storage it
 * made, and the regeneration a stale record asked behind it, both counted in the request's point.
 */

const FLIGHT = 'the Function rendered Flight';
const ROUTE = '/[slug]';
const PATHNAME = '/member';
/** Older than the record's revalidation, so reading it asks a regeneration behind the request. */
const STALE_BY_MS = 10 * 60 * 1000;

/** A stale member record whose Flight part was never stored. */
async function keepStaleMember(scopeId: string) {
  const { entryId } = await deriveEntry(scopeId, {
    kind: 'app-page',
    route: ROUTE,
    pathname: PATHNAME,
  });
  const document = pprDocument();
  const html = encodeUtf8(document.shellText + document.suffixText);
  const part = encodeUtf8('a Flight part storage lost');
  const produced = Date.now() - STALE_BY_MS;
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
      route: ROUTE,
      pathname: PATHNAME,
      cacheTimestamp: produced,
      producedAt: produced,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 3600 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [
        {
          artifactId: 'artifact_member_flight',
          sha256: await sha256Hex(part),
          byteLength: part.byteLength,
          contentType: 'text/x-component',
          encoding: 'identity',
          role: 'rsc',
          representationKey: 'rsc',
          storageRef: `lost/${crypto.randomUUID()}`,
        },
      ],
    },
    html,
    undefined,
  );
  await env.CACHE_STATE.put(kvGenerationKey(scopeId, entryId), bytes);
}

async function askedForFlight() {
  const site = await seedSite({
    document: pprDocument(),
    pathname: '/unrelated',
    dynamicRoutes: [{ sourceRegex: '^/member$', members: { route: ROUTE, kind: 'app-page' } }],
  });
  const scopeId = `member-part-${crypto.randomUUID()}`;
  await keepStaleMember(scopeId);
  const manifest: ProjectManifest = { ...site.manifest, cache: { keySchemaVersion: 1, scopeId } };
  const points: EdgeMetric[] = [];
  const dispatched: Request[] = [];
  const host = standaloneHost(env);
  const request = new Request<unknown, IncomingRequestCfProperties>(
    `https://site.example${PATHNAME}`,
    { headers: { [RSC_HEADER]: '1' } },
  );
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
          dispatched.push(handed);
          return Promise.resolve(
            new Response(FLIGHT, { headers: { 'content-type': 'text/x-component' } }),
          );
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
      pointer: { ...site.pointer, app: { deploymentId: 'dpl_site', scriptName: 'site-app' } },
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
      policyLookup: Promise.resolve({
        kind: 'found',
        source: 'exact',
        policy: {
          ...DEFAULT_DELIVERY_POLICY,
          runtimeCache: {
            ...DEFAULT_RUNTIME_CACHE_SETTINGS,
            generations: 'on',
            cacheApiMaxAgeMs: 0,
          },
        },
      }),
    },
  );
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body, points, dispatched };
}

describe("a member's Flight part storage no longer holds", () => {
  it("counts the part's read and the regeneration it asked in the handoff's point", async () => {
    const { response, body, points, dispatched } = await askedForFlight();

    expect(response.status).toBe(200);
    expect(body).toBe(FLIGHT);
    // The regeneration asked behind the request, and the request handed on.
    expect(dispatched).toHaveLength(2);
    expect(points).toHaveLength(1);
    // Both dispatches, and the read of the part storage did not hold.
    expect(points[0]?.subrequests).toBe(3);
  });
});
