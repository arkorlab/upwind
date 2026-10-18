import { KEY_SCHEMA_VERSION } from '@stayingupwind/core/cache';
import { toBase64Url } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cacheScopeSchema, ENTITY_SCHEMA_VERSION, scopeSeedSchema } from '../src/cache/index.ts';
import {
  MAX_SCOPE_ID_LENGTH,
  parseCacheToken,
  signCacheToken,
  verifyCacheToken,
} from '../src/cache/token.ts';

const SECRET = 'cache-token-key-for-tests-32-chars!!';
const SCOPE = 'dpl_4Fixture2Minima1AppXy';
const OTHER = 'dpl_3Qk9mWpZ2rT7bX1vN8sLd';
const PARTS = 3;
const NAMING = { tokenLabel: 'test-cache-token' };
/** Scope ids holding what no bearer token in a header can: whitespace, a control, past ASCII. */
const UNCARRIED = ['a b', 'a\tb', 'a\nb', 'a\0b', 'a\u{7F}b', 'café', '日本'];
/**
 * Scope ids holding what a header carries, but a bearer token does not (RFC 6750, `b64token`), and
 * `=`, a token's padding, which a scope id has no use for at its end or anywhere else.
 */
const UNTOKENED = ['a,b', 'a"b', String.raw`a\b`, 'a=b', 'ab='];
/**
 * Scope ids holding `/`, which a bearer token holds, but which follows a scope's id in every key its
 * storage is kept under: `a/b`'s would be kept under `a`'s.
 */
const NESTED = ['a/b', 'a/', '/a'];
/** Every character a bearer token holds, but `.`, `=` and `/`. */
const TOKENED = 'AZaz09-_~+';

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

  it('can be minted for the longest id the scope authority accepts', async () => {
    const scopeId = 'a'.repeat(MAX_SCOPE_ID_LENGTH);
    const token = await signCacheToken(SECRET, scopeId, NAMING);

    expect(parseCacheToken(token)?.scopeId).toBe(scopeId);
    await expect(
      verifyCacheToken({ token, scopeId, secret: SECRET, naming: NAMING }),
    ).resolves.toBe(true);
  });

  it('refuses a longer scope before importing a signing key', async () => {
    const importKey = vi.spyOn(crypto.subtle, 'importKey');

    await expect(
      signCacheToken(SECRET, 'a'.repeat(MAX_SCOPE_ID_LENGTH + 1), NAMING),
    ).rejects.toThrow(`a scope id is at most ${MAX_SCOPE_ID_LENGTH} characters`);
    expect(importKey).not.toHaveBeenCalled();
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

  /**
   * A token is a bearer an `Authorization` header carries: one signed for a scope id holding any of
   * these could not be presented by any request, or could be refused by a strict reader of it.
   */
  it.each([...UNCARRIED, ...UNTOKENED])(
    'cannot be minted for a scope id that holds %j',
    async (id) => {
      await expect(signCacheToken(SECRET, id, NAMING)).rejects.toThrow(/ASCII letters, digits/u);
    },
  );

  /** A scope no storage could keep apart from another is given no token to open it with. */
  it.each(NESTED)('cannot be minted for a scope id that nests under another, as %j', async (id) => {
    await expect(signCacheToken(SECRET, id, NAMING)).rejects.toThrow(/ASCII letters, digits/u);
  });

  it('can be presented in an Authorization header', async () => {
    const token = await signCacheToken(SECRET, SCOPE, NAMING);

    expect(new Headers({ authorization: `Bearer ${token}` }).get('authorization')).toBe(
      `Bearer ${token}`,
    );
  });

  it('can be minted for a scope id of every other character a bearer token holds', async () => {
    const token = await signCacheToken(SECRET, TOKENED, NAMING);

    expect(parseCacheToken(token)?.scopeId).toBe(TOKENED);
    await expect(
      verifyCacheToken({ token, scopeId: TOKENED, secret: SECRET, naming: NAMING }),
    ).resolves.toBe(true);
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
    expect(scopeSeedSchema.safeParse({ ...scope, scopeId: TOKENED }).success).toBe(true);
    await expect(signCacheToken(SECRET, scope.scopeId, NAMING)).resolves.toMatch(/^v1\./u);
  });

  /**
   * As long an id as the authority answers about, and none longer: refused where the scope is made,
   * rather than seeded and never answered about.
   */
  it('is seeded under an id as long as the authority answers about, and none longer', () => {
    const longest = 'a'.repeat(MAX_SCOPE_ID_LENGTH);

    expect(scopeSeedSchema.safeParse({ ...scope, scopeId: longest }).success).toBe(true);
    expect(scopeSeedSchema.safeParse({ ...scope, scopeId: `${longest}a` }).success).toBe(false);
  });

  /** Refused where the scope is made, rather than once it is and its token cannot be signed. */
  it.each(['a.b', 'b|v1|c', ...UNCARRIED, ...UNTOKENED, ...NESTED])(
    'is not seeded under %j, which no token can be signed for',
    (id) => {
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
    },
  );
});
