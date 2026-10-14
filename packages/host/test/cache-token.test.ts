import { KEY_SCHEMA_VERSION } from '@stayingupwind/core/cache';
import { toBase64Url } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cacheScopeSchema, ENTITY_SCHEMA_VERSION, scopeSeedSchema } from '../src/cache/index.ts';
import { parseCacheToken, signCacheToken, verifyCacheToken } from '../src/cache/token.ts';

const SECRET = 'cache-token-key-for-tests-32-chars!!';
const SCOPE = 'dpl_4Fixture2Minima1AppXy';
const OTHER = 'dpl_3Qk9mWpZ2rT7bX1vN8sLd';
const PARTS = 3;
const NAMING = { tokenLabel: 'test-cache-token' };

describe('cache tokens', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('name their scope and verify for it under the key that signed them', async () => {
    const token = await signCacheToken(SECRET, SCOPE, NAMING);

    expect(token.startsWith(`v1.${SCOPE}.`)).toBe(true);
    expect(parseCacheToken(token)?.scopeId).toBe(SCOPE);
    await expect(
      verifyCacheToken({ token, scopeId: SCOPE, secret: SECRET, naming: NAMING }),
    ).resolves.toBe(true);
  });

  it('open no other scope, and nothing under another key', async () => {
    const token = await signCacheToken(SECRET, SCOPE, NAMING);
    const signature = token.split('.', PARTS)[2] ?? '';
    const forged = ['v1', OTHER, signature].join('.');

    await expect(
      verifyCacheToken({ token, scopeId: OTHER, secret: SECRET, naming: NAMING }),
    ).resolves.toBe(false);
    await expect(
      verifyCacheToken({ token, scopeId: SCOPE, secret: 'another-key', naming: NAMING }),
    ).resolves.toBe(false);
    await expect(
      verifyCacheToken({ token: forged, scopeId: OTHER, secret: SECRET, naming: NAMING }),
    ).resolves.toBe(false);
  });

  it("open nothing under another host's label", async () => {
    const token = await signCacheToken(SECRET, SCOPE, NAMING);

    await expect(
      verifyCacheToken({
        token,
        scopeId: SCOPE,
        secret: SECRET,
        naming: { tokenLabel: 'another-cache-token' },
      }),
    ).resolves.toBe(false);
  });

  it('sign no label or scope that could be read as another pair of them', async () => {
    // `a` over `b|v1|c` and `a|v1|b` over `c` would sign the same bytes.
    await expect(signCacheToken(SECRET, 'b|v1|c', { tokenLabel: 'a' })).rejects.toThrow(
      'neither a token label nor a scope id may carry |',
    );
    await expect(signCacheToken(SECRET, 'c', { tokenLabel: 'a|v1|b' })).rejects.toThrow(
      'neither a token label nor a scope id may carry |',
    );
  });

  it('open nothing for a label or a scope that carries the field separator', async () => {
    const token = await signCacheToken(SECRET, SCOPE, NAMING);
    const signature = token.split('.', PARTS)[2] ?? '';

    await expect(
      verifyCacheToken({
        token: ['v1', 'b|v1|c', signature].join('.'),
        scopeId: 'b|v1|c',
        secret: SECRET,
        naming: NAMING,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyCacheToken({
        token,
        scopeId: SCOPE,
        secret: SECRET,
        naming: { tokenLabel: 'test|cache-token' },
      }),
    ).resolves.toBe(false);
  });

  it('still verify under the previous key while a rotation is under way', async () => {
    const token = await signCacheToken('old-key', SCOPE, NAMING);

    await expect(
      verifyCacheToken({
        token,
        scopeId: SCOPE,
        secret: SECRET,
        previousSecret: 'old-key',
        naming: NAMING,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyCacheToken({ token, scopeId: SCOPE, secret: SECRET, naming: NAMING }),
    ).resolves.toBe(false);
  });

  it.each([
    '',
    'v1',
    `v1.${SCOPE}`,
    `v1.${SCOPE}.`,
    `v2.${SCOPE}.abc`,
    `v1..abc`,
    `v1.${SCOPE}.a.b`,
  ])('do not parse %j', async (token) => {
    expect(parseCacheToken(token)).toBeUndefined();
    await expect(
      verifyCacheToken({ token, scopeId: SCOPE, secret: SECRET, naming: NAMING }),
    ).resolves.toBe(false);
  });

  /** An HMAC-SHA-256 is 32 bytes: a signature of any other length is refused before any is made. */
  it.each([31, 33, 1024])('do not parse a signature of %i bytes', async (length) => {
    const token = ['v1', SCOPE, toBase64Url(new Uint8Array(length))].join('.');
    const importKey = vi.spyOn(crypto.subtle, 'importKey');

    expect(parseCacheToken(token)).toBeUndefined();
    await expect(
      verifyCacheToken({ token, scopeId: SCOPE, secret: SECRET, naming: NAMING }),
    ).resolves.toBe(false);
    expect(importKey).not.toHaveBeenCalled();
  });

  /** Another spelling of the same 32 bytes, as the codec reads one, is the same signature. */
  it('still verify with the signature spelled padded', async () => {
    const token = await signCacheToken(SECRET, SCOPE, NAMING);

    await expect(
      verifyCacheToken({ token: `${token}=`, scopeId: SCOPE, secret: SECRET, naming: NAMING }),
    ).resolves.toBe(true);
  });

  it('cannot be minted for a scope id that carries the separator', async () => {
    await expect(signCacheToken(SECRET, 'a.b', NAMING)).rejects.toThrow(/separator/u);
  });
});

describe('a scope', () => {
  const scope = {
    scopeId: SCOPE,
    organizationId: 'org',
    projectId: 'prj',
    environmentId: 'production',
    deploymentId: SCOPE,
    keySchemaVersion: KEY_SCHEMA_VERSION,
    buildId: 'build',
  } as const;

  it('is seeded under an id a token can be signed for', async () => {
    expect(scopeSeedSchema.safeParse(scope).success).toBe(true);
    await expect(signCacheToken(SECRET, scope.scopeId, NAMING)).resolves.toMatch(/^v1\./u);
  });

  /** Refused where the scope is made, rather than once it is and its token cannot be signed. */
  it.each(['a.b', 'b|v1|c'])('is not seeded under %j, which no token can be signed for', (id) => {
    expect(scopeSeedSchema.safeParse({ ...scope, scopeId: id }).success).toBe(false);
    expect(
      cacheScopeSchema.safeParse({
        ...scope,
        scopeId: id,
        status: 'active',
        seededAt: 1,
        schemaVersion: ENTITY_SCHEMA_VERSION,
      }).success,
    ).toBe(false);
  });
});
