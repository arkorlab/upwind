import { describe, expect, it, vi } from 'vitest';

import type { DataRead, DataValue } from '../src/cache/host.ts';
import { createCacheRuntime, type DataMemo } from '../src/cache/runtime.ts';

/**
 * What a value of the data cache an isolate keeps counts against the room its memo has: its bytes,
 * and its answer in the characters JSON would write it in — counted from its strings, not by writing
 * it out whole, which for a value kept inline copied its whole base64 on the read's path.
 */

const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: 'scope-memo-bytes',
};
const T0 = 1_800_000_000_000;
const KIB = 1024;
const UTF16_BYTES = 2;
/** What an answer says beside the strings counted on their own, at the most (`dataBytes`). */
const ALLOWANCE_CHARACTERS = 512;

/** An answer of a value read as `value`, under `tags`. */
function answerOf(value: DataValue, tags: readonly string[]): DataRead {
  return {
    entryId: 'entry_memo_bytes',
    generationId: 'generation_memo_bytes',
    dependencyRevision: 7,
    entry: {
      kind: 'data:use-cache',
      handler: 'default',
      tags,
      stale: 300,
      timestamp: T0,
      expire: 31_536_000,
      revalidate: 900,
    },
    value,
    invalidation: { revision: 7, staleAt: T0, hardExpireAt: T0 },
  };
}

/** A memo of `response`, its bytes `bytes` long. */
function memoOf(response: DataRead, bytes: number): DataMemo {
  return { kind: 'found', response, bytes: new Uint8Array(bytes) };
}

/** The key each memo of these tests is kept under. */
const KEY = 'key';

/** What `memo` counts for once kept, and how many characters keeping it wrote as JSON. */
function kept(memo: DataMemo): { readonly used: number; readonly written: number } {
  const runtime = createCacheRuntime({ env: ENV, now: () => T0 });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    runtime.dataMemo.set(KEY, memo);
    const written = stringify.mock.results.reduce(
      (sum, result) => sum + (typeof result.value === 'string' ? result.value.length : 0),
      0,
    );
    return { used: runtime.dataMemo.usedBytes, written };
  } finally {
    stringify.mockRestore();
  }
}

/** What JSON writes each of `values` in, quotes and escapes included. */
function writtenLengths(...values: readonly string[]): number {
  return values.reduce((sum, value) => sum + JSON.stringify(value).length, 0);
}

describe('what a data memo counts for', () => {
  it('counts a value kept inline by the length of its base64, writing none of it out as JSON', () => {
    const base64 = 'A'.repeat(512 * KIB);
    const tags = ['products', 'product-1'];
    const response = answerOf({ kind: 'inline', base64 }, tags);
    const strings =
      writtenLengths('entry_memo_bytes', 'generation_memo_bytes', 'default', ...tags) +
      base64.length;

    const { used, written } = kept(memoOf(response, 384 * KIB));

    // The short strings alone, never the base64.
    expect(written).toBeLessThan(KIB);
    expect(used).toBeGreaterThanOrEqual(384 * KIB + (strings + KEY.length) * UTF16_BYTES);
    expect(used).toBeLessThanOrEqual(
      384 * KIB + (strings + KEY.length + ALLOWANCE_CHARACTERS + tags.length) * UTF16_BYTES,
    );
    // Never less than its JSON, which is what it counted for before.
    expect(used).toBeGreaterThanOrEqual(
      384 * KIB + (JSON.stringify(response).length + KEY.length) * UTF16_BYTES,
    );
  });

  it('counts a value kept as an artifact by the length of its id', () => {
    const artifactId = `artifact_${'m'.repeat(1000)}`;
    const response = answerOf({ kind: 'ref', artifactId }, []);
    const strings =
      writtenLengths('entry_memo_bytes', 'generation_memo_bytes', 'default', artifactId) +
      KEY.length;

    const { used, written } = kept(memoOf(response, 2 * KIB));

    expect(written).toBeLessThan(2 * KIB);
    // The id counted, longer than the allowance beside it (cubic).
    expect(used).toBeGreaterThanOrEqual(2 * KIB + strings * UTF16_BYTES);
    expect(used).toBeLessThanOrEqual(2 * KIB + (strings + ALLOWANCE_CHARACTERS) * UTF16_BYTES);
  });

  it('counts the escapes JSON writes tags in, never less than its JSON (cubic)', () => {
    const tags = Array.from({ length: 200 }, (_, index) => `${'"\\'.repeat(10)}${index}`);
    const response = answerOf({ kind: 'inline', base64: 'AAAA' }, tags);

    const { used } = kept(memoOf(response, KIB));

    expect(used).toBeGreaterThanOrEqual(
      KIB + (JSON.stringify(response).length + KEY.length) * UTF16_BYTES,
    );
  });
});
