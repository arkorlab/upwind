import { finiteSeconds } from '@stayingupwind/core/cache';
import { describe, expect, test } from 'vitest';

import type { GenerationState, InvalidationEvent, TagState } from '../../src/aws/model.ts';
import { condemnation, mergedTag, weighCommit } from '../../src/aws/semantics.ts';

function data(timestamp: number): GenerationState {
  return {
    id: 'generation',
    seq: 1,
    source: 'runtime',
    cacheTimestamp: timestamp,
    producedAt: timestamp,
    policy: {
      revalidateAfter: finiteSeconds(60),
      expireAfter: finiteSeconds(3600),
      clientStale: finiteSeconds(0),
      source: 'runtime-output',
    },
    status: 200,
    headers: {},
    outputs: [],
    tags: [{ kind: 'next-explicit', value: 'tag' }],
    data: {
      byteLength: 1,
      entry: {
        kind: 'data:fetch',
        tags: ['tag'],
        timestamp,
        stale: 0,
        revalidate: 60,
        expire: 3600,
      },
      value: { kind: 'inline', base64: 'eA==' },
    },
  };
}

function event(
  revision: number,
  staleAt: number,
  window: number,
  sparedAfter: number | null = null,
): InvalidationEvent {
  return { revision, staleAt, hardExpireAt: staleAt + window, values: ['tag'], sparedAfter };
}

describe('AWS invalidation timeline parity', () => {
  test('an existing value stamped ahead of the authority is expired when no in-force time was supplied', () => {
    const tag = mergedTag(undefined, event(2, 20, 0), 'tag');
    expect(condemnation(data(50), 1, new Map([['tag', tag]]), 1)).toMatchObject({
      revision: 2,
      hardExpireAt: 20,
    });
    // A new value arriving after the invalidation follows dataCondemnation's timestamp rule.
    expect(condemnation(data(50), 3, new Map([['tag', tag]]), 3)).toBeUndefined();
  });

  test('a future in-force time spares no preexisting value below the actual worker moment', () => {
    const tag = mergedTag(undefined, event(2, 20, 0, 100), 'tag');
    expect(condemnation(data(50), 1, new Map([['tag', tag]]), 1)).toBeDefined();
    expect(condemnation(data(101), 1, new Map([['tag', tag]]), 1)).toBeUndefined();
  });

  test('held immediate invalidation excuses its earlier window, while a later window still condemns', () => {
    let tag = mergedTag(undefined, event(1, 10, 300), 'tag');
    tag = mergedTag(tag, event(2, 20, 0), 'tag');
    tag = mergedTag(tag, event(3, 30, 600), 'tag');
    const result = weighCommit(['tag'], new Map([['tag', tag]]), 0, 2, { tag: 2 });
    expect(result).toMatchObject({
      refused: false,
      dependencyRevision: 2,
      condemned: { revision: 3, staleAt: 30 },
    });
    expect(weighCommit(['tag'], new Map([['tag', tag]]), 0, 2, {}).refused).toBe(true);
  });

  test('folding many short SWR windows never manufactures an immediate invalidation', () => {
    let tag: TagState | undefined;
    for (let revision = 1; revision <= 40; revision += 1)
      tag = mergedTag(tag, event(revision, revision * 1000, 1000), 'tag');
    if (tag === undefined) throw new Error('tag missing');
    expect(tag.history.length).toBeLessThanOrEqual(16);
    expect(tag.dataHistory.length).toBeLessThanOrEqual(16);
    expect(weighCommit(['tag'], new Map([['tag', tag]]), 0, 0, {}).refused).toBe(false);
  });
});
