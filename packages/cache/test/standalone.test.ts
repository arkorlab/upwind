import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { verifyCacheToken } from '@stayingupwind/host/cache';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { STANDALONE_AUTHORITY } from '../src/standalone/host.ts';

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
});
