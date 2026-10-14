import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { verifyCacheToken } from '@stayingupwind/host/cache';
import { createExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { scopeStub } from '../src/scope/stub.ts';
import { STANDALONE_AUTHORITY } from '../src/standalone/host.ts';
import { CacheControl } from '../src/standalone/worker.ts';

const SCOPE_ID = createId(DEPLOYMENT_ID_PREFIX);

function seedInput(scopeId: string): Parameters<typeof exports.CacheControl.seedScope>[0] {
  return {
    scope: {
      scopeId,
      organizationId: 'org_site',
      projectId: 'site',
      environmentId: 'production',
      deploymentId: scopeId,
      keySchemaVersion: 1,
      buildId: 'build-site',
    },
  };
}

describe('a standalone cache', () => {
  it('seeds a scope and hands back a token signed under its own label', async () => {
    const seeded = await exports.CacheControl.seedScope(seedInput(SCOPE_ID));
    const token = seeded.kind === 'conflict' ? '' : seeded.token;
    const key = env.CACHE_TOKEN_KEY ?? '';

    expect(seeded).toMatchObject({ kind: 'seeded', revision: 1 });
    await expect(
      verifyCacheToken({
        secret: key,
        scopeId: SCOPE_ID,
        token,
        naming: STANDALONE_AUTHORITY.naming,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyCacheToken({
        secret: key,
        scopeId: SCOPE_ID,
        token,
        naming: { tokenLabel: 'another' },
      }),
    ).resolves.toBe(false);
  });

  it('answers a deployment’s Function at its gateway with the scope’s token, and no other', async () => {
    const scopeId = createId(DEPLOYMENT_ID_PREFIX);
    const seeded = await exports.CacheControl.seedScope(seedInput(scopeId));
    const token = seeded.kind === 'conflict' ? '' : seeded.token;
    const resolve = (bearer: string): Promise<Response> => {
      return exports.default.fetch(
        new Request(`https://cache.invalid/v1/scopes/${scopeId}/entries/resolve`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify({ entry: { kind: 'app-page', route: '/', pathname: '/' } }),
        }),
      );
    };

    const answered = await resolve(token);
    const refused = await resolve(`${token}x`);

    expect(answered.status).toBe(200);
    expect(refused.status).toBe(401);
  });

  /**
   * A scope's keys join its id to what follows with `:` in KV and `/` in the bucket: a scope `a:b`
   * beside `a` would have its records read with `a`'s token, and one `a/b` its artifacts erased with
   * `a`'s. Neither is seeded, nothing of it kept, and no token signed for it.
   */
  it.each([':', '/'])(
    'seeds no scope whose id carries %j, and signs it no token',
    async (joint) => {
      const control = new CacheControl(createExecutionContext(), env);
      const scopeId = `${createId(DEPLOYMENT_ID_PREFIX)}${joint}b`;
      const seed = seedInput(createId(DEPLOYMENT_ID_PREFIX));

      await expect(
        control.seedScope({ ...seed, scope: { ...seed.scope, scopeId } }),
      ).rejects.toThrow(/neither : nor \//u);
      await expect(control.issueToken({ scopeId })).rejects.toThrow(/neither : nor \//u);
      await expect(
        scopeStub(env, scopeId).seedEntries({ scopeId, batchIndex: 0, entries: [] }, 0),
      ).resolves.toMatchObject({ kind: 'refused', code: 'not_found' });
    },
  );
});
