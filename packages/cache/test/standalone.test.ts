import { sha256Hex } from '@stayingupwind/core/artifact';
import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { verifyCacheToken } from '@stayingupwind/host/cache';
import type { UploadedArtifact } from '@stayingupwind/runtime/cache-host';
import { createExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { Gateway } from '../src/function/gateway.ts';
import { scopeStub } from '../src/scope/stub.ts';
import { STANDALONE_AUTHORITY } from '../src/standalone/host.ts';
import { CacheControl, CacheSignals } from '../src/standalone/worker.ts';

const SCOPE_ID = createId(DEPLOYMENT_ID_PREFIX);

/** An authority answer whose valid digests may still name the wrong output. */
function batchAnswer(kind: string, artifacts: UploadedArtifact[]): UploadedArtifact[] {
  switch (kind) {
    case 'swapped': {
      return artifacts.toReversed();
    }
    case 'digest': {
      return artifacts.map((artifact) => ({ ...artifact, sha256: '0'.repeat(64) }));
    }
    case 'length': {
      return artifacts.map((artifact) => ({ ...artifact, byteLength: artifact.byteLength + 1 }));
    }
    case 'missing': {
      return artifacts.slice(0, -1);
    }
    case 'extra': {
      return [...artifacts, artifacts[0]!];
    }
    default: {
      return artifacts;
    }
  }
}

/** Equal-length outputs in one upload, answered by a host whose reply the test controls. */
async function batchFixture(answer: string) {
  const uploads = ['left', 'rite'].map((body) => {
    return {
      attemptId: 'attempt-batch',
      fencingToken: 1,
      role: 'html' as const,
      bytes: new TextEncoder().encode(body),
      contentType: 'text/html',
    };
  });
  const artifacts = await Promise.all(
    uploads.map(async (upload) => {
      const sha256 = await sha256Hex(upload.bytes);
      return { sha256, byteLength: upload.bytes.byteLength };
    }),
  );
  const requests: Request[] = [];
  const gateway = new Gateway({
    scopeId: 'dpl_batch',
    token: 'token',
    gatewayUrl: 'https://authority.invalid',
    naming: { copyCache: 'batch-test', copyKeyOrigin: 'https://copies.invalid' },
    fetchImpl: (request) => {
      requests.push(request);
      return Promise.resolve(
        Response.json({ ok: true, result: { artifacts: batchAnswer(answer, artifacts) } }),
      );
    },
  });
  return { gateway, uploads, artifacts, requests };
}

describe('a Function upload batch', () => {
  it('accepts the ordered digests of the bytes it sent', async () => {
    const { gateway, uploads, artifacts, requests } = await batchFixture('correct');

    await expect(gateway.uploadArtifacts(uploads)).resolves.toStrictEqual(artifacts);
    expect(requests).toHaveLength(1);
  });

  it.each(['swapped', 'digest', 'length', 'missing', 'extra'])(
    'refuses the answer when its artifacts are %s',
    async (answer) => {
      const { gateway, uploads, requests } = await batchFixture(answer);

      await expect(gateway.uploadArtifacts(uploads)).rejects.toThrow(
        'the upload batch was answered with other artifacts',
      );
      expect(requests).toHaveLength(1);
    },
  );
});

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

      // The scope's own schema refuses either before its token is signed: `:` is none of a bearer
      // token's characters, and `/` is left out of them for the keys' sake. Asked for a token
      // alone, the keys' rule (`isScopeId`) refuses either.
      await expect(
        control.seedScope({ ...seed, scope: { ...seed.scope, scopeId } }),
      ).rejects.toThrow(/ASCII letters, digits/u);
      await expect(control.issueToken({ scopeId })).rejects.toThrow(/neither : nor \//u);
      await expect(
        scopeStub(env, scopeId).seedEntries({ scopeId, batchIndex: 0, entries: [] }, 0),
      ).resolves.toMatchObject({ kind: 'refused', code: 'not_found' });
    },
  );

  /**
   * A scope's token carries its id, and is presented as a bearer in an `Authorization` header,
   * which holds no control character, nothing a byte cannot and, in a bearer token, no space and
   * none of `,`, `"` or `\` (RFC 6750): a scope named with one could be seeded and never opened, or
   * opened only where no reader of the header is strict. Nor `=`, a token's padding. None is seeded,
   * signed a token, or answered about.
   */
  it.each(['\n', ' ', '\t', '\0', '日', ',', '"', '\\', '='])(
    'seeds no scope whose id holds %j, and signs it no token',
    async (held) => {
      const control = new CacheControl(createExecutionContext(), env);
      // Asked of an instance, as `control` is, not over `exports`: an RPC call's promise is
      // callable, so `rejects` calls it and awaits that call instead, and the refusal of the call
      // itself is left unhandled.
      const signals = new CacheSignals(createExecutionContext(), env);
      const scopeId = `${createId(DEPLOYMENT_ID_PREFIX)}${held}b`;
      const seed = seedInput(createId(DEPLOYMENT_ID_PREFIX));

      await expect(
        control.seedScope({ ...seed, scope: { ...seed.scope, scopeId } }),
      ).rejects.toThrow(/ASCII letters, digits/u);
      await expect(control.issueToken({ scopeId })).rejects.toThrow(/ASCII letters, digits/u);
      await expect(signals.scopeSignals(scopeId, null)).rejects.toThrow(/no such scope/u);
    },
  );

  /** A bearer token's other characters, which neither a token nor the keys separate with. */
  it('seeds a scope whose id holds -, _, ~ and +, signs it a token, and answers about it', async () => {
    const control = new CacheControl(createExecutionContext(), env);
    const scopeId = `${createId(DEPLOYMENT_ID_PREFIX)}-_~+`;
    const seed = seedInput(createId(DEPLOYMENT_ID_PREFIX));

    await expect(
      control.seedScope({ ...seed, scope: { ...seed.scope, scopeId } }),
    ).resolves.toMatchObject({ kind: 'seeded' });

    const { token } = await control.issueToken({ scopeId });

    expect(token).toContain(`.${scopeId}.`);
    await expect(exports.CacheSignals.scopeSignals(scopeId, null)).resolves.toMatchObject({
      revision: 0,
    });
  });

  /**
   * An edge is answered about no scope id past 256 characters: one longer is neither seeded nor
   * signed a token, rather than seeded and never answered where it stands.
   */
  it('seeds a scope id as long as an edge is answered about, and none longer', async () => {
    const control = new CacheControl(createExecutionContext(), env);
    const longest = createId(DEPLOYMENT_ID_PREFIX).padEnd(256, 'x');
    const longer = `${longest}x`;
    const seed = seedInput(createId(DEPLOYMENT_ID_PREFIX));

    await expect(
      control.seedScope({ ...seed, scope: { ...seed.scope, scopeId: longest } }),
    ).resolves.toMatchObject({ kind: 'seeded' });
    await expect(exports.CacheSignals.scopeSignals(longest, null)).resolves.toMatchObject({
      revision: 0,
    });
    await expect(
      control.seedScope({ ...seed, scope: { ...seed.scope, scopeId: longer } }),
    ).rejects.toThrow(/at most 256/u);
    await expect(control.issueToken({ scopeId: longer })).rejects.toThrow(/at most 256/u);
  });
});
