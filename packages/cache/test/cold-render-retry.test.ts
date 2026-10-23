import { createId } from '@stayingupwind/core/util';
import type { FailRequest, FetchLike } from '@stayingupwind/runtime/cache-host';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cacheHostFor } from '../src/function/cache-host.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
const FAILED_AT = NOW + 1;
const DEFAULT_BACKOFF_MS = 2000;
const ENTRY = { kind: 'app-page', route: '/recovery/[slug]', pathname: '/recovery/a' } as const;
const SCENARIOS = [
  { retryAfterMs: 0, delay: 0, immediateKind: 'leased' },
  { retryAfterMs: 250, delay: 250, immediateKind: 'busy' },
  { retryAfterMs: undefined, delay: DEFAULT_BACKOFF_MS, immediateKind: 'busy' },
] as const;

/** Hold the authority's own clock, which each lease change reads, at the time it is asked at. */
function at(time: number): number {
  vi.spyOn(Date, 'now').mockReturnValue(time);
  return time;
}

async function coldScope() {
  const scopeId = createId('dpl');
  const stub = scopeStub(env, scopeId);
  await stub.seedScope(
    {
      scope: {
        scopeId,
        organizationId: 'owner',
        projectId: 'site',
        environmentId: 'production',
        deploymentId: scopeId,
        keySchemaVersion: 1,
        buildId: 'build',
      },
    },
    NOW,
  );
  const attempt = await stub.startAttempt({ entry: ENTRY, reason: 'miss' }, at(NOW));
  if (attempt.kind !== 'leased') throw new Error('Missing cold render lease');
  return { stub, attempt };
}

function functionHost(send: FetchLike) {
  const createHost = cacheHostFor({
    copyCache: 'retry-copies',
    copyKeyOrigin: 'https://copies.example',
  });
  const binding = createHost({
    env: {
      ARKOR_CACHE_GATEWAY_URL: 'https://authority.example',
      ARKOR_CACHE_READ_GATEWAY_URL: 'https://read.example',
      ARKOR_CACHE_TOKEN: 'scope-token',
      NEXT_DEPLOYMENT_ID: 'scope-retry',
    },
    fetchImpl: send,
  });
  if (binding === undefined) throw new Error('Missing Function cache host');
  return binding.host;
}

function requireRequest(request: Request | undefined): Request {
  if (request === undefined) throw new Error('Missing failure request');
  return request;
}

function failure(fencingToken: number, retryAfterMs: number | undefined): FailRequest {
  return {
    fencingToken,
    outcome: 'failed',
    error: { code: 'render_failed', message: 'The cold render failed.' },
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  };
}

async function authorityRetry(retryAfterMs: number | undefined) {
  const { stub, attempt } = await coldScope();
  const delay = retryAfterMs ?? DEFAULT_BACKOFF_MS;
  const failed = await stub.fail(
    attempt.attemptId,
    failure(attempt.fencingToken, retryAfterMs),
    at(FAILED_AT),
  );
  const immediate = await stub.startAttempt({ entry: ENTRY, reason: 'miss' }, FAILED_AT);
  const next =
    delay === 0
      ? immediate
      : await stub.startAttempt({ entry: ENTRY, reason: 'miss' }, at(FAILED_AT + delay));
  if (next.kind !== 'leased') throw new Error('Missing retry lease');
  // Replaying the failed attempt must neither release nor reschedule the new holder.
  const replay = await stub.fail(
    attempt.attemptId,
    failure(attempt.fencingToken, 0),
    FAILED_AT + delay,
  );
  const duplicate = await stub.startAttempt({ entry: ENTRY, reason: 'miss' }, FAILED_AT + delay);
  return { failed, immediate, next, replay, duplicate, attempt };
}

describe('cold render retry scheduling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(SCENARIOS)(
    'preserves retry delay $retryAfterMs through the Function host',
    async (scenario) => {
      const send = vi.fn<FetchLike>().mockResolvedValue(
        Response.json({
          ok: true,
          result: { regeneration: 'failed', nextRetryAt: FAILED_AT + scenario.delay },
        }),
      );
      const host = functionHost(send);
      const request = failure(1, scenario.retryAfterMs);

      await host.fail('attempt-retry', request);

      expect(send).toHaveBeenCalledTimes(1);

      const sent = requireRequest(send.mock.calls[0]?.[0]);

      expect(sent.method).toBe('POST');
      expect(new URL(sent.url).pathname).toContain('/attempts/attempt-retry/fail');
      await expect(sent.json()).resolves.toStrictEqual(request);
    },
  );

  it.each(SCENARIOS)(
    'honors retry delay $retryAfterMs while preserving a live replacement lease',
    async (scenario) => {
      const result = await authorityRetry(scenario.retryAfterMs);

      expect(result.failed).toStrictEqual({
        regeneration: 'failed',
        nextRetryAt: FAILED_AT + scenario.delay,
      });
      expect(result.immediate.kind).toBe(scenario.immediateKind);
      expect(result.next).toMatchObject({
        kind: 'leased',
        current: null,
        fencingToken: result.attempt.fencingToken + 1,
      });
      expect(result.next.attemptId).not.toBe(result.attempt.attemptId);
      expect(result.replay).toStrictEqual({ regeneration: 'running', nextRetryAt: null });
      expect(result.duplicate).toMatchObject({ kind: 'busy', attemptId: result.next.attemptId });
    },
  );
});
