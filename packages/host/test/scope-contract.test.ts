import { describe, expect, it } from 'vitest';

import {
  listResourceWarmJobsResultSchema,
  MAX_RESOURCE_WARM_JOBS,
  seedScopeResultSchema,
} from '../src/cache/scope-contract.ts';

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

describe('the warm jobs one call leases', () => {
  const job = {
    jobId: 'job_1',
    resourceId: 'res_1',
    eventId: 'evt_1',
    version: 1,
    requiredRevision: 0,
    entryId: 'ent_1',
    entryKind: 'app-page',
    route: '/',
    pathname: '/',
    leaseToken: 'lease',
    leaseExpiresAt: 1,
  } as const;

  function answer(count: number) {
    return {
      jobs: Array.from({ length: count }, (_, index) => ({ ...job, jobId: `job_${index}` })),
      nextRetryAt: null,
    };
  }

  it('come to as many as a call may ask for', () => {
    expect(listResourceWarmJobsResultSchema.safeParse(answer(MAX_RESOURCE_WARM_JOBS)).success).toBe(
      true,
    );
  });

  it('come to no more than a call may ask for', () => {
    expect(
      listResourceWarmJobsResultSchema.safeParse(answer(MAX_RESOURCE_WARM_JOBS + 1)).success,
    ).toBe(false);
  });
});
