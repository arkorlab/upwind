import { createId, encodeUtf8 } from '@stayingupwind/core/util';
import { type AttemptError, attemptErrorSchema } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { assert, describe, expect, it } from 'vitest';

import { scopeStub } from '../src/scope/stub.ts';

async function failedWith(error?: AttemptError) {
  const scopeId = createId('dpl');
  const stub = scopeStub(env, scopeId);
  const now = Date.now();
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
    now,
  );
  const started = await stub.startAttempt(
    { entry: { kind: 'app-page', route: '/', pathname: '/' }, reason: 'manual' },
    now,
  );
  assert(started.kind === 'leased', 'the render acquired its lease');
  const result = await stub.fail(
    started.attemptId,
    {
      fencingToken: started.fencingToken,
      outcome: 'failed',
      ...(error !== undefined && { error }),
    },
    now,
  );
  const stored = await runInDurableObject(stub, (_instance, state) => {
    return state.storage.sql
      .exec<{ error: string | null; status: string }>(
        'SELECT error, status FROM attempts WHERE attempt_id = ?',
        started.attemptId,
      )
      .one();
  });
  return { result, stored };
}

describe('retained render failure diagnostics', () => {
  it.each([
    { label: 'plain text', message: 'failure '.repeat(40_000) },
    { label: 'escaped control characters', message: '\0'.repeat(60_000) },
    { label: 'Unicode', message: '失敗😀'.repeat(30_000) },
  ])(
    'accepts a large $label failure and retains bounded diagnostic prefixes',
    async ({ message }) => {
      const error = { code: 'render_failure_'.repeat(1000), message };
      const { result, stored } = await failedWith(error);
      assert(stored.error !== null, 'the failed attempt retained diagnostics');
      const retained = attemptErrorSchema.parse(JSON.parse(stored.error));

      expect(result).toMatchObject({ regeneration: 'failed' });
      expect(stored.status).toBe('failed');
      expect(encodeUtf8(stored.error).byteLength).toBeLessThanOrEqual(4096);
      expect(retained.code.length).toBeGreaterThan(0);
      expect(retained.message.length).toBeGreaterThan(0);
      expect(retained.code).toBe(error.code.slice(0, retained.code.length));
      expect(retained.message).toBe(message.slice(0, retained.message.length));
      expect(retained.message).not.toBe(message);
    },
  );

  it('retains a small diagnostic unchanged', async () => {
    const error = { code: 'render_failed', message: 'the dependency was unavailable' };
    const { stored } = await failedWith(error);

    expect(stored.error).toBe(JSON.stringify(error));
  });

  it('retains no diagnostic when none was supplied', async () => {
    const { stored } = await failedWith();

    expect(stored).toStrictEqual({ error: null, status: 'failed' });
  });
});
