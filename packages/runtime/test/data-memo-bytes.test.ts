import { describe, expect, it, vi } from 'vitest';

import type { DataRead, DataValue } from '../src/cache/host.ts';
import { createCacheRuntime, type DataMemo } from '../src/cache/runtime.ts';

/**
 * What a value of the data cache an isolate keeps counts against the room its memo has: its bytes,
 * and its answer in the characters JSON would write it in — counted from the lengths of its strings,
 * not by writing it out, which for a value kept inline copied its whole base64 on the read's path.
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

/** What `memo` counts for once kept, and what keeping it wrote as JSON. */
function kept(memo: DataMemo): { readonly used: number; readonly written: number } {
  const runtime = createCacheRuntime({ env: ENV, now: () => T0 });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    runtime.dataMemo.set(KEY, memo);
    return { used: runtime.dataMemo.usedBytes, written: stringify.mock.calls.length };
  } finally {
    stringify.mockRestore();
  }
}

describe('what a data memo counts for', () => {
  it('counts a value kept inline by the length of its base64, writing nothing out as JSON', () => {
    const base64 = 'A'.repeat(512 * KIB);
    const tags = ['products', 'product-1'];
    const response = answerOf({ kind: 'inline', base64 }, tags);
    const strings =
      'entry_memo_bytes'.length +
      'generation_memo_bytes'.length +
      'default'.length +
      tags.join('').length +
      base64.length;

    const { used, written } = kept(memoOf(response, 384 * KIB));

    expect(written).toBe(0);
    expect(used).toBeGreaterThanOrEqual(384 * KIB + (strings + KEY.length) * UTF16_BYTES);
    expect(used).toBeLessThanOrEqual(
      384 * KIB + (strings + KEY.length + ALLOWANCE_CHARACTERS + 3 * tags.length) * UTF16_BYTES,
    );
    // Never less than its JSON, which is what it counted for before.
    expect(used).toBeGreaterThanOrEqual(
      384 * KIB + (JSON.stringify(response).length + KEY.length) * UTF16_BYTES,
    );
  });

  it('counts a value kept as an artifact by the length of its id', () => {
    const response = answerOf({ kind: 'ref', artifactId: 'artifact_memo_bytes' }, []);

    const { used, written } = kept(memoOf(response, 2 * KIB));

    expect(written).toBe(0);
    expect(used).toBeLessThanOrEqual(2 * KIB + (ALLOWANCE_CHARACTERS + 128) * UTF16_BYTES);
  });
});
