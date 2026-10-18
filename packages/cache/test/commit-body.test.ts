import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';
import { type CommitRequest, commitRequestSchema } from '@stayingupwind/host/cache';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GatewayEnv } from '../src/gateway/auth.ts';
import { attemptRoutes, COMMIT_BODY_BYTES } from '../src/gateway/routes/attempts.ts';

const UNKNOWN = { kind: 'unknown' } as const;

/** A render's one document, before its tags or response headers are filled in. */
function commit(): CommitRequest {
  return {
    fencingToken: 1,
    observedTagRevision: 0,
    generation: {
      cacheTimestamp: 1,
      producedAt: 1,
      policy: {
        revalidateAfter: UNKNOWN,
        expireAfter: UNKNOWN,
        clientStale: UNKNOWN,
        source: 'runtime-output',
      },
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      outputs: [
        {
          representationKey: 'html',
          pathname: '/',
          status: 200,
          headers: {},
          compute: 'static',
          response: 'complete',
          htmlSize: null,
          artifacts: [
            {
              role: 'html',
              sha256: 'a'.repeat(64),
              byteLength: 1,
              contentType: 'text/html',
              encoding: 'identity',
            },
          ],
        },
      ],
      dependencies: [],
      dependencyCoverage: 'complete',
    },
  };
}

/** The real commit handler, with only its authority RPC replaced: no parsed body may reach it. */
function gateway() {
  const publish = vi.fn().mockResolvedValue({
    kind: 'published',
    generationId: 'generation',
    seq: 1,
    revision: 1,
    condemned: null,
  });
  const app = new Hono<GatewayEnv>();
  app.use('*', async (c, next) => {
    c.set('scope', { commit: publish } as unknown as GatewayEnv['Variables']['scope']);
    c.set('now', 1);
    await next();
  });
  app.route('/', attemptRoutes);
  return { app, publish };
}

describe('a commit body before it reaches the scope queue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a mebibyte of valid response headers before parsing or sending the RPC', async () => {
    const request = commit();
    request.generation.headers = Object.fromEntries(
      Array.from({ length: 100_000 }, (_, index) => [index.toString(36), '']),
    );
    const text = JSON.stringify(request);
    const { app, publish } = gateway();

    expect(text.length).toBeLessThanOrEqual(COMMIT_BODY_BYTES);
    expect(commitRequestSchema.validate(request)).toBe(true);

    const parse = vi.spyOn(JSON, 'parse');
    const response = await app.request('/attempts/attempt/commit', { method: 'POST', body: text });

    expect(response.status).toBe(400);
    expect(parse).not.toHaveBeenCalledWith(text);
    expect(publish).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request', message: 'a JSON body may hold at most 16384 values' },
    });
  });

  it('takes every tag and held revision at their bounds, with punctuation inside their strings', async () => {
    const request = commit();
    const punctuation = String.raw`\",{}[]`.repeat(MAX_TAG_LENGTH);
    const tags = Array.from({ length: MAX_TAGS_PER_ENTRY }, (_, index) =>
      `${String(index)}${punctuation}`.slice(0, MAX_TAG_LENGTH),
    );
    request.generation.tags = tags.map((value) => ({ kind: 'next-explicit', value }));
    request.heldTagRevisions = Object.fromEntries(tags.map((tag) => [tag, 1]));
    const text = JSON.stringify(request);
    const { app, publish } = gateway();

    expect(text.length).toBeGreaterThan(16_384);
    expect(text.length).toBeLessThanOrEqual(COMMIT_BODY_BYTES);

    const response = await app.request('/attempts/attempt/commit', { method: 'POST', body: text });

    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledExactlyOnceWith('attempt', request, 1);
  });
});
