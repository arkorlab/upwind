import { describe, expect, it } from 'vitest';

import { seedScopeResultSchema } from '../src/cache/scope-contract.ts';

describe("a seed's answer", () => {
  /** What a host's history says beside the authority's own fields, whatever the answer. */
  const history = { note: 'kept', recording: { epoch: 2 } };

  it.each([
    { kind: 'seeded', revision: 1, token: 'v1.scope.signature' },
    { kind: 'already-seeded', revision: 3, token: 'v1.scope.signature' },
    { kind: 'conflict', reason: 'the scope is retired' },
  ])('keeps what the history says beside a $kind answer', (answer) => {
    expect(seedScopeResultSchema.parse({ ...answer, ...history })).toStrictEqual({
      ...answer,
      ...history,
    });
  });
});
