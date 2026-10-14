import { describe, expect, it } from 'vitest';

import {
  listResourceWarmJobsResultSchema,
  MAX_RESOURCE_WARM_JOBS,
  MAX_SEED_OUTPUT_ARTIFACTS,
  MAX_SEED_OUTPUTS,
  seedEntriesInputSchema,
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

/** One entry of a batch, its build's generation made of `outputs`. */
function batchOf(outputs: readonly unknown[]) {
  const unknown = { kind: 'unknown' };
  return {
    scopeId: 'dpl_scope',
    batchIndex: 0,
    entries: [
      {
        descriptor: { kind: 'app-page', route: '/', pathname: '/' },
        groupInstanceId: null,
        generation: {
          generationId: 'gen_1',
          cacheTimestamp: 1,
          producedAt: 1,
          policy: {
            revalidateAfter: unknown,
            expireAfter: unknown,
            clientStale: unknown,
            source: 'build-output',
          },
          status: 200,
          headers: {},
          tags: [],
          outputs,
          dependencyCoverage: 'complete',
        },
      },
    ],
  };
}

describe('a seed batch', () => {
  const artifact = {
    role: 'html',
    sha256: 'a'.repeat(64),
    byteLength: 1,
    contentType: 'text/html',
    encoding: 'identity',
    storageRef: `blobs/${'a'.repeat(64)}`,
  };
  const output = {
    representationKey: 'html',
    pathname: '/',
    status: 200,
    headers: {},
    compute: 'static',
    response: 'complete',
    htmlSize: null,
    artifacts: [artifact],
  };

  it('holds an entry of as many outputs, each of as many artifacts, as a seed may', () => {
    const artifacts = Array.from({ length: MAX_SEED_OUTPUT_ARTIFACTS }, () => artifact);
    const outputs = Array.from({ length: MAX_SEED_OUTPUTS }, () => ({ ...output, artifacts }));

    expect(seedEntriesInputSchema.safeParse(batchOf(outputs)).success).toBe(true);
  });

  /** The entry count alone bounded nothing of what each entry held. */
  it('holds no entry of more outputs, or of an output of more artifacts, than a seed may', () => {
    const outputs = Array.from({ length: MAX_SEED_OUTPUTS + 1 }, () => output);
    const artifacts = Array.from({ length: MAX_SEED_OUTPUT_ARTIFACTS + 1 }, () => artifact);

    expect(seedEntriesInputSchema.safeParse(batchOf(outputs)).success).toBe(false);
    expect(seedEntriesInputSchema.safeParse(batchOf([{ ...output, artifacts }])).success).toBe(
      false,
    );
  });
});
