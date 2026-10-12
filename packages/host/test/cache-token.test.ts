import { describe, expect, it } from 'vitest';

import { parseCacheToken, signCacheToken, verifyCacheToken } from '../src/cache/token.ts';

const SECRET = 'cache-token-key-for-tests-32-chars!!';
const SCOPE = 'dpl_4Fixture2Minima1AppXy';
const OTHER = 'dpl_3Qk9mWpZ2rT7bX1vN8sLd';
const PARTS = 3;
const NAMING = { tokenLabel: 'test-cache-token' };

describe('cache tokens', () => {
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

  it('cannot be minted for a scope id that carries the separator', async () => {
    await expect(signCacheToken(SECRET, 'a.b', NAMING)).rejects.toThrow(/separator/u);
  });
});
