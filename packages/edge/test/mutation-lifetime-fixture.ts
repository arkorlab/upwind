import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  type DecodedGenerationPack,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import type { AppRuntime } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { vi } from 'vitest';

import { condemnedIn } from '../src/cache/condemned.ts';
import { decideGeneration } from '../src/cache/decision.ts';
import type { DispatchApp, EdgeRuntime } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { routeRequest } from '../src/route.ts';
import type { StandaloneEnv } from '../src/standalone/env.ts';
import { standaloneHost } from '../src/standalone/host.ts';

export const SCOPE = 'mutation-lifetime-scope';
const NOW = 1_800_000_000_000;

class Invocation {
  readonly held: Promise<unknown>[] = [];

  waitUntil(work: Promise<unknown>): void {
    // A method with a receiver, like the native context: an unbound call must fail this control.
    this.held.push(work);
  }
}

async function oldRecord(scopeId: string, tag: string, entryId: string) {
  const html = new TextEncoder().encode('<p>before mutation</p>');
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId,
      entryId,
      generationId: 'old-generation',
      seq: 1,
      source: 'runtime',
      kind: 'app-page',
      route: '/',
      pathname: '/',
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      tags: [{ kind: 'next-explicit', value: tag }],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
      revision: 1,
    },
    html,
    undefined,
  );
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('fixture record did not decode');
  return { pack: decoded.pack, bytes: bytes.byteLength, readAt: NOW };
}

/** Actual routing and generation decisions; only dispatch and the invocation context are mocked. */
export function mutationLifetimeFixture(): ReturnType<typeof createMutationLifetimeFixture> {
  return createMutationLifetimeFixture();
}

async function createMutationLifetimeFixture() {
  const target = await oldRecord(SCOPE, 'posts', 'old-entry');
  const otherTag = await oldRecord(SCOPE, 'unrelated', 'other-entry');
  const otherScope = await oldRecord('another-scope', 'posts', 'other-scope-entry');
  const { pack } = target;
  const memory = createEdgeMemory(() => NOW);
  const recordKey = kvGenerationKey(SCOPE, pack.header.entryId);
  const unrelated = [otherTag, otherScope];
  for (const record of [target, ...unrelated]) {
    memory.generations.set(
      kvGenerationKey(record.pack.header.scopeId, record.pack.header.entryId),
      record,
      record.bytes,
    );
  }
  const invocation = new Invocation();
  const waitUntil = vi.spyOn(invocation, 'waitUntil');
  const ctx = invocation as unknown as ExecutionContext;
  const env = {} as StandaloneEnv;
  const dispatch = vi.fn<DispatchApp>(() => Promise.resolve(new Response('original')));
  const now = vi.fn(() => NOW);
  const runtime: EdgeRuntime = {
    fetchImpl: vi.fn(() => Promise.reject(new Error('unexpected network call'))),
    dispatchApp: dispatch,
    memory,
    now,
    transformImage: undefined,
    blobWorker: undefined,
  };
  const select = (selected: DecodedGenerationPack) => {
    return decideGeneration(
      { kind: 'generation', pack: selected, source: 'memory', readBytes: undefined, lookupMs: 0 },
      NOW,
      condemnedIn(memory),
    );
  };
  return {
    dispatch,
    held: invocation.held,
    memory,
    now,
    recordKey,
    waitUntil,
    /** The same old record a subsequent GET's generation read would judge. */
    selection: () => select(pack),
    unrelated: () => {
      return unrelated.map(({ pack: other }) => {
        return {
          decision: select(other).kind,
          unchanged:
            memory.generations.get(kvGenerationKey(other.header.scopeId, other.header.entryId))
              ?.pack === other,
        };
      });
    },
    serve: (request: Request, functions?: AppRuntime['functions']) => {
      return routeRequest({
        request: request as IncomingRequest,
        url: new URL(request.url),
        env,
        ctx,
        runtime,
        host: standaloneHost(env),
        state: {
          projectId: 'project',
          mode: 'passthrough',
          cspNonce: false,
          cspNonceMode: 'enforce',
          cspStrictDynamic: false,
          cacheApi: false,
          privateDelivery: false,
          manifestId: 'manifest',
          manifest: undefined,
          app: {
            scriptName: 'function',
            deploymentId: SCOPE,
            ...(functions !== undefined && { functions }),
          },
          policy: DEFAULT_DELIVERY_POLICY,
          originHost: 'app.test',
          validated: false,
          passthroughReason: 'fixture',
          demotedRoutes: undefined,
        },
        timings: { pointerMs: 0, manifestMs: 0, middlewareMs: undefined },
      });
    },
  };
}
