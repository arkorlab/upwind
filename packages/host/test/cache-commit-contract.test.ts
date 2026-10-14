import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import { commitRequestSchema } from '../src/cache/gateway-contract.ts';

const UNKNOWN = { kind: 'unknown' } as const;

/** A commit of a page's one document, with what `generation` changes of it. */
function commit(generation: Record<string, unknown> = {}) {
  return {
    fencingToken: 1,
    observedTagRevision: 0,
    generation: {
      cacheTimestamp: 1,
      producedAt: 1,
      policy: {
        revalidateAfter: UNKNOWN,
        expireAfter: UNKNOWN,
        clientStale: UNKNOWN,
        source: 'runtime-output',
      },
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      tags: [],
      outputs: [
        {
          representationKey: 'html',
          pathname: '/',
          status: 200,
          headers: {},
          compute: 'static',
          response: 'complete',
          htmlSize: null,
          artifacts: [
            {
              role: 'html',
              sha256: 'a'.repeat(64),
              byteLength: 1,
              contentType: 'text/html',
              encoding: 'identity',
            },
          ],
        },
      ],
      dependencies: [],
      dependencyCoverage: 'complete',
      ...generation,
    },
  };
}

describe("a commit's status", () => {
  it.each([200, 307, 404, 599])('is %i, which a response may be made with', (status) => {
    expect(commitRequestSchema.safeParse(commit({ status })).success).toBe(true);
  });

  /** A generation committed with it could be answered with nowhere. */
  it.each([0, 101, 199, 600, 999])('is not %i, which no response may be made with', (status) => {
    expect(() => new Response(null, { status })).toThrow(RangeError);
    expect(commitRequestSchema.safeParse(commit({ status })).success).toBe(false);
  });
});

describe("a commit's headers", () => {
  it('are what a response can be made with', () => {
    const headers = { 'content-type': 'text/html', 'x-note': 'café', $name: 'a\tb' };

    expect(() => new Headers(headers)).not.toThrow();
    expect(commitRequestSchema.safeParse(commit({ headers })).success).toBe(true);
  });

  /** `Headers` throws on each of these wherever a generation committed with it is served. */
  it.each([
    ['a value that carries a line break', { 'x-note': 'a\r\nset-cookie: b=1' }],
    ['a value that carries NUL', { 'x-note': 'a\0b' }],
    ['a value past what a byte carries', { 'x-note': '日本' }],
    ['a name that is not a token', { 'x note': 'a' }],
  ])('are not %s', (_, headers) => {
    expect(() => new Headers(headers)).toThrow(TypeError);
    expect(commitRequestSchema.safeParse(commit({ headers })).success).toBe(false);
  });
});

/** What the commit says its renderer's view held of `count` tags, each at a revision of its own. */
function heldOf(count: number): Record<string, number> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`tag-${String(index)}`, index]),
  );
}

describe('what a commit says its view held of its tags', () => {
  /** A runtime from before says nothing of it, and its commit is judged as one whose view held none. */
  it('may be left out', () => {
    expect(commitRequestSchema.safeParse(commit()).success).toBe(true);
  });

  it('is a revision of each of as many tags as a generation may carry', () => {
    const request = { ...commit(), heldTagRevisions: heldOf(MAX_TAGS_PER_ENTRY) };

    expect(commitRequestSchema.safeParse(request).success).toBe(true);
  });

  it.each([
    ['of more tags than a generation may carry', heldOf(MAX_TAGS_PER_ENTRY + 1)],
    ['of an empty tag', { '': 1 }],
    ['of a tag longer than a tag may be', { ['t'.repeat(MAX_TAG_LENGTH + 1)]: 1 }],
    ['at a revision below none', { home: -1 }],
    ['at a revision that is no whole number', { home: 1.5 }],
    ['at a revision that is no number', { home: '1' }],
  ])('is not %s', (_, heldTagRevisions) => {
    const request = { ...commit(), heldTagRevisions };

    expect(commitRequestSchema.safeParse(request).success).toBe(false);
  });
});
