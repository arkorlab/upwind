import { MAX_TAG_LENGTH } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import {
  MAX_RECENT_INVALIDATIONS,
  MAX_SIGNALS_BYTES,
  type ScopeSignals,
} from '../src/cache/index.ts';

/** The widest a number in an answer is written. */
const WIDEST = -Number.MAX_SAFE_INTEGER;

describe('a scope signals answer', () => {
  /**
   * Every record the answer may hold, each of a tag as long as a tag may be in the character JSON
   * writes longest, its id as long as one is, and each moment as wide as a number is written.
   */
  it('comes to no more than MAX_SIGNALS_BYTES as JSON, however long its tags', () => {
    const signals: ScopeSignals = {
      revision: WIDEST,
      invalidatedAt: WIDEST,
      tags: Array.from({ length: MAX_RECENT_INVALIDATIONS }, () => {
        return {
          tagId: `tag_${'x'.repeat(21)}`,
          kind: 'platform-delivery',
          value: '\0'.repeat(MAX_TAG_LENGTH),
          revision: WIDEST,
          staleAt: WIDEST,
          hardExpireAt: WIDEST,
          meaning: 'immediate',
        } as const;
      }),
      truncated: true,
      announced: false,
    };

    expect(new TextEncoder().encode(JSON.stringify(signals)).byteLength).toBeLessThanOrEqual(
      MAX_SIGNALS_BYTES,
    );
  });
});
