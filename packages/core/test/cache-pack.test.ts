import { describe, expect, it } from 'vitest';

import { type GenerationTag, MAX_TAGS_PER_ENTRY } from '../src/cache/keys.ts';
import {
  type DecodedGenerationPack,
  decodeGenerationPack,
  encodeGenerationPack,
  type GenerationPackHeader,
  packBodyDigests,
  verifyGenerationPack,
} from '../src/cache/pack.ts';
import { policyFromBuild } from '../src/cache/timing.ts';
import { encodeUtf8 } from '../src/util/bytes.ts';

/** 2026-09-20T00:00:00Z */
const T0 = 1_789_862_400_000;
const SIXTY = 60;
const MAGIC_LENGTH = 4;

const html = encodeUtf8('<!doctype html><html><body>hello</body></html>');
const postponed = encodeUtf8('{"postponed":true}');

interface Body {
  readonly html: Uint8Array;
  readonly postponed: Uint8Array | undefined;
}

async function header(
  overrides: Partial<GenerationPackHeader> = {},
  body?: Body,
): Promise<GenerationPackHeader> {
  const measured = body ?? { html, postponed };
  return {
    schemaVersion: 1,
    scopeId: 'dpl_4Fixture2Minima1AppXy',
    entryId: 'ent_1',
    generationId: 'gen_1',
    seq: 1,
    source: 'build',
    kind: 'app-page',
    route: '/',
    pathname: '/',
    cacheTimestamp: T0,
    producedAt: T0,
    policy: policyFromBuild({ initialRevalidate: SIXTY }),
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    tags: [{ kind: 'next-implicit', value: '_N_T_/layout' }],
    ...(await packBodyDigests(measured.html, measured.postponed)),
    artifacts: [],
    revision: 1,
    ...overrides,
  };
}

/** The pack a record decodes to; a record that does not decode fails the test here. */
function decoded(bytes: Uint8Array): DecodedGenerationPack {
  const result = decodeGenerationPack(bytes);
  if (result.kind !== 'ok') {
    throw new Error(`expected a pack, got ${result.kind}`);
  }
  return result.pack;
}

/** As many distinct tags as asked for, each one a render could have left. */
function someTags(count: number): GenerationTag[] {
  const tags: GenerationTag[] = [];
  for (let index = 0; index < count; index += 1) {
    tags.push({ kind: 'next-explicit', value: `product-${index}` });
  }
  return tags;
}

/** The same bytes with one of them changed, at `index`. */
function edited(bytes: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[index] = copy[index] === 0 ? 1 : 0;
  return copy;
}

describe('a generation pack', () => {
  it('round-trips its header, shell and postponed state', async () => {
    const written = await header();
    const pack = decoded(encodeGenerationPack(written, html, postponed));

    expect(pack.header).toStrictEqual(written);
    expect(pack.html).toStrictEqual(html);
    expect(pack.postponed).toStrictEqual(postponed);
    await expect(verifyGenerationPack(pack)).resolves.toBe(true);
  });

  it('carries a page that nothing resumes, and a zero-byte body that is a body', async () => {
    const empty = new Uint8Array(0);
    const written = await header({}, { html: empty, postponed: undefined });
    const pack = decoded(encodeGenerationPack(written, empty, undefined));

    expect(pack.postponed).toBeUndefined();
    expect(pack.html.byteLength).toBe(0);
    expect(pack.header.postponedSha256).toBeNull();
    await expect(verifyGenerationPack(pack)).resolves.toBe(true);
  });

  it('refuses to be written with a header that does not measure its bytes', async () => {
    const written = await header({ htmlLength: html.byteLength + 1 });

    expect(() => encodeGenerationPack(written, html, postponed)).toThrow(/measure/u);
  });

  it('is corrupt when truncated', async () => {
    const bytes = encodeGenerationPack(await header(), html, postponed);

    expect(decodeGenerationPack(bytes.subarray(0, bytes.byteLength - 1))).toStrictEqual({
      kind: 'corrupt',
      reason: 'body lengths do not add up to the record',
    });
  });

  it('fails verification when a byte of the shell was edited', async () => {
    const bytes = encodeGenerationPack(await header(), html, postponed);
    const pack = decoded(edited(bytes, bytes.byteLength - postponed.byteLength - 1));

    await expect(verifyGenerationPack(pack)).resolves.toBe(false);
  });

  it('is unsupported, never a record to serve, under a version this code does not know', async () => {
    const bytes = edited(encodeGenerationPack(await header(), html, postponed), MAGIC_LENGTH);

    expect(decodeGenerationPack(bytes)).toStrictEqual({ kind: 'unsupported', version: 0 });
  });

  it.each([
    ['nothing', new Uint8Array(0)],
    ['another magic', encodeUtf8('PPRX\u{1}\u{0}\u{0}\u{0}\u{0}')],
    ['a header longer than the record', encodeUtf8('PPRG\u{1}\u{FF}\u{FF}\u{0}\u{0}')],
  ])('is corrupt given %s', (_label, bytes) => {
    expect(decodeGenerationPack(bytes).kind).toBe('corrupt');
  });

  it('is corrupt when the header is not the schema', async () => {
    const written = await header();
    const bytes = encodeGenerationPack(written, html, postponed);
    const text = new TextDecoder().decode(bytes);
    const swapped = text.replaceAll('"seq":1', '"seq":0');

    expect(decodeGenerationPack(encodeUtf8(swapped))).toMatchObject({ kind: 'corrupt' });
  });

  it('is corrupt when the header disagrees with itself about the postponed state', async () => {
    const disagreeing = await header({ postponedSha256: null });
    const bytes = encodeGenerationPack(disagreeing, html, postponed);

    expect(decodeGenerationPack(bytes)).toStrictEqual({
      kind: 'corrupt',
      reason: 'postponed state and its hash disagree',
    });
  });

  /**
   * What a whole render accumulates, not what one call of Next.js's `validateTags` allows: a page
   * of twenty tagged fetches passes 128 without any one of them coming near it, and held to 128
   * the entry's commit was refused for good and it never got a generation at all.
   */
  it('carries as many tags as a render may leave, and no more', async () => {
    // Twenty tagged fetches of ten tags each: under Next.js's own per-call limit every time, and
    // past what this record used to carry.
    const wholeRender = 200;
    const many = await header({ tags: someTags(wholeRender) });
    const tooMany = await header({ tags: someTags(MAX_TAGS_PER_ENTRY + 1) });

    expect(decoded(encodeGenerationPack(many, html, postponed)).header.tags).toHaveLength(
      wholeRender,
    );
    expect(decodeGenerationPack(encodeGenerationPack(tooMany, html, postponed))).toMatchObject({
      kind: 'corrupt',
    });
  });
});
