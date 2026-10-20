import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import {
  listResourceWarmJobsResultSchema,
  MAX_RESOURCE_WARM_JOBS,
  MAX_SEED_BATCH,
  MAX_SEED_OUTPUT_ARTIFACTS,
  MAX_SEED_OUTPUTS,
  seedEntriesInputSchema,
  seedEntriesResultSchema,
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

/** A seed batch's answer that leaves `count` of its entries unseeded. */
function refusing(count: number) {
  return {
    inserted: 0,
    skipped: 0,
    refused: Array.from({ length: count }, (_, index) => {
      return {
        descriptor: { kind: 'app-page', route: '/[slug]', pathname: `/${index}` },
        reason: 'no record of it could be written',
      };
    }),
    revision: 1,
  };
}

describe('the entries one seed batch leaves unseeded', () => {
  it('come to as many as a batch may hold', () => {
    expect(seedEntriesResultSchema.safeParse(refusing(MAX_SEED_BATCH)).success).toBe(true);
  });

  /** Each is an entry the batch held, and a batch holds no more than `MAX_SEED_BATCH`. */
  it('come to no more than a batch may hold', () => {
    expect(seedEntriesResultSchema.safeParse(refusing(MAX_SEED_BATCH + 1)).success).toBe(false);
  });
});

/**
 * One entry of a batch, its build's generation made of `outputs`, carrying `tags` and answered with
 * `status` and `headers`.
 */
function batchOf(
  outputs: readonly unknown[],
  tags: readonly unknown[] = [],
  status = 200,
  headers: Readonly<Record<string, string>> = {},
) {
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
          status,
          headers,
          tags,
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

  it.each([1, 2, 3, undefined])('retains the supported build proof %j', (staticPagePrivacy) => {
    const marked = { ...output, staticPagePrivacy };
    const parsed = seedEntriesInputSchema.parse(batchOf([marked]));

    expect(parsed.entries[0]?.generation.outputs[0]?.staticPagePrivacy).toBe(staticPagePrivacy);
  });

  it.each([0, 4, '3', null])('rejects an unknown build proof %j', (staticPagePrivacy) => {
    expect(
      seedEntriesInputSchema.safeParse(batchOf([{ ...output, staticPagePrivacy }])).success,
    ).toBe(false);
  });

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

  /**
   * A route's tags are its build's: past what a generation may carry, they leave the authority to
   * refuse that entry alone, where refused in the batch's shape they would leave every entry of it
   * unseeded.
   */
  it('holds an entry whose tags are past what a generation may carry', () => {
    const long = [{ kind: 'next-implicit', value: `_N_T_/${'a'.repeat(MAX_TAG_LENGTH)}` }];
    const many = Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, (_, index) => `tag-${index}`).map(
      (value) => ({ kind: 'next-explicit', value }),
    );

    expect(seedEntriesInputSchema.safeParse(batchOf([output], long)).success).toBe(true);
    expect(seedEntriesInputSchema.safeParse(batchOf([output], many)).success).toBe(true);
  });

  it('holds no tag that is empty, or of no kind a tag may be', () => {
    const empty = [{ kind: 'next-explicit', value: '' }];
    const kindless = [{ kind: 'unknown-kind', value: 'tag' }];

    expect(seedEntriesInputSchema.safeParse(batchOf([output], empty)).success).toBe(false);
    expect(seedEntriesInputSchema.safeParse(batchOf([output], kindless)).success).toBe(false);
  });

  it.each([200, 307, 404, 599])(
    'holds an entry seeded with status %i, which a response may be made with',
    (status) => {
      expect(seedEntriesInputSchema.safeParse(batchOf([output], [], status)).success).toBe(true);
    },
  );

  it('holds an entry seeded with headers a response may carry', () => {
    const headers = {
      'cache-control': 's-maxage=60',
      'x-nextjs-cache': 'HIT',
      vary: 'rsc, accept',
    };

    expect(seedEntriesInputSchema.safeParse(batchOf([output], [], 200, headers)).success).toBe(
      true,
    );
  });

  /** Answered with them as a commit's generation is, which `Headers` refuses to be made with. */
  it.each([{ 'not a name': 'value' }, { 'x-split': 'one\r\ntwo' }, { 'x-wide': '日本' }])(
    'holds no entry seeded with headers %j, which no response may carry',
    (headers) => {
      expect(seedEntriesInputSchema.safeParse(batchOf([output], [], 200, headers)).success).toBe(
        false,
      );
    },
  );

  /** Seeded, it would be its entry's current generation, which no host could answer with. */
  it.each([0, 101, 199, 600, 999])(
    'holds no entry seeded with status %i, which no response may be made with',
    (status) => {
      expect(() => new Response(null, { status })).toThrow(RangeError);
      expect(seedEntriesInputSchema.safeParse(batchOf([output], [], status)).success).toBe(false);
    },
  );
});
