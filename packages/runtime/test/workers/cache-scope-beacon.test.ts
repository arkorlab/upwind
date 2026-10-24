import { afterEach, describe, expect, it, vi } from 'vitest';

import { cacheHostFor } from '../../../cache/src/function/cache-host.ts';
import type { CacheHost, FetchLike } from '../../src/cache/host.ts';
import { installRequestContext, withRequestContext } from '../../src/request-context.ts';
import { createCacheHost as beaconlessHost } from '../function-cache-host.ts';

/**
 * Where a deployment's scope stands, as its Function's data center keeps it where the host asks for
 * that (`upwind/packages/cache/src/function/scope-beacon.ts`): asked of the authority behind a
 * request, by one isolate of the data center at a time, kept in the Cache API for the others, and
 * asked again once it is a moment old — the old answer standing meanwhile. A host whose edge says
 * it on every request keeps none.
 *
 * Run inside workerd, since the Cache API is what is under test. The authority is a stand-in for the
 * one route the beacon takes. Each test works under a scope of its own, so no copy one test keeps is
 * found by another. A host made afresh stands for another isolate in the same data center.
 */

const GATEWAY_URL = 'https://authority.test';
const TOKEN = 'test-scope-token';
const NOW = 1_790_000_000_000;
const SECOND = 1000;

const beaconHost = cacheHostFor(
  { copyCache: 'beacon-test-copies', copyKeyOrigin: 'https://copies.beacon.invalid' },
  { scopeBeacon: true },
);

function scopeOfItsOwn(): string {
  return `scope-${crypto.randomUUID()}`;
}

interface Authority {
  readonly fetchImpl: FetchLike;
  /** How many times where the scope stands was asked. */
  readonly asked: () => number;
  /** Move the scope on to `revision`, invalidated at `at`. */
  readonly invalidate: (revision: number, at: number) => void;
}

function authority(): Authority {
  let asked = 0;
  let standing: { revision: number; invalidatedAt: number | null } = {
    revision: 0,
    invalidatedAt: null,
  };
  return {
    asked: () => asked,
    invalidate: (revision, at) => {
      standing = { revision, invalidatedAt: at };
    },
    fetchImpl: (request) => {
      if (new URL(request.url).pathname.endsWith('/tags/revision')) {
        asked += 1;
        return Promise.resolve(Response.json({ ok: true, result: standing }));
      }
      return Promise.resolve(new Response('not the revision route', { status: 500 }));
    },
  };
}

function hostOf(
  scopeId: string,
  fetchImpl: FetchLike,
  make: typeof beaconHost = beaconHost,
  token = TOKEN,
): CacheHost {
  const binding = make({
    env: {
      ARKOR_CACHE_GATEWAY_URL: GATEWAY_URL,
      ARKOR_CACHE_TOKEN: token,
      NEXT_DEPLOYMENT_ID: scopeId,
    },
    fetchImpl,
  });
  if (binding === undefined) {
    throw new Error('these bindings reach no cache');
  }
  return binding.host;
}

/** What `host` says of its scope, in a request, what it left behind it put in `behind`. */
async function readLeaving(host: CacheHost, behind: Promise<unknown>[]): Promise<unknown> {
  installRequestContext();
  return withRequestContext(
    {
      headers: {},
      url: 'https://app.test/',
      waitUntil: (promise) => {
        behind.push(promise);
      },
    },
    async () => host.scopeRevision?.(),
  );
}

/** What `host` says of its scope, in a request, and once what it left behind it has settled. */
async function readIn(host: CacheHost): Promise<unknown> {
  const behind: Promise<unknown>[] = [];
  const answer = await readLeaving(host, behind);
  await Promise.all(behind);
  return answer;
}

/**
 * An authority that answers where the scope stands as `revision`, once `answered` resolves, and
 * says how many times it was asked.
 */
function slowAuthority(
  revision: number,
  answered: Promise<unknown>,
): { readonly fetchImpl: FetchLike; readonly asked: () => number } {
  let asked = 0;
  return {
    asked: () => asked,
    fetchImpl: async (request) => {
      if (!new URL(request.url).pathname.endsWith('/tags/revision')) {
        return new Response('not the revision route', { status: 500 });
      }
      asked += 1;
      await answered;
      return Response.json({ ok: true, result: { revision, invalidatedAt: NOW } });
    },
  };
}

describe('where a scope stands, as a data center keeps it', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is asked of the authority behind the first request, and kept for the data center', async () => {
    const scopeId = scopeOfItsOwn();
    const asked = authority();
    asked.invalidate(4, NOW);

    const first = await readIn(hostOf(scopeId, asked.fetchImpl));
    const elsewhere = await readIn(hostOf(scopeId, asked.fetchImpl));

    expect(first).toBeUndefined();
    expect(elsewhere).toStrictEqual({ revision: 4, invalidatedAt: NOW });
    expect(asked.asked()).toBe(1);
  });

  it('is asked again once it is a moment old, the old answer standing meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const scopeId = scopeOfItsOwn();
    const asked = authority();
    asked.invalidate(4, NOW);
    await readIn(hostOf(scopeId, asked.fetchImpl));

    asked.invalidate(9, NOW + SECOND);
    vi.setSystemTime(NOW + 2 * SECOND);
    const stale = await readIn(hostOf(scopeId, asked.fetchImpl));
    const caughtUp = await readIn(hostOf(scopeId, asked.fetchImpl));

    expect(stale).toStrictEqual({ revision: 4, invalidatedAt: NOW });
    expect(caughtUp).toStrictEqual({ revision: 9, invalidatedAt: NOW + SECOND });
    expect(asked.asked()).toBe(2);
  });

  it('is not taken back by an answer that comes back after a later one was kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const scopeId = scopeOfItsOwn();
    const late = Promise.withResolvers<true>();
    const slow = slowAuthority(5, late.promise);
    const asked = authority();
    asked.invalidate(9, NOW + SECOND);
    const lateBehind: Promise<unknown>[] = [];

    // One isolate's question is out past its claim; another's is answered, and kept, meanwhile.
    await readLeaving(hostOf(scopeId, slow.fetchImpl), lateBehind);
    await vi.waitFor(() => {
      expect(slow.asked()).toBe(1);
    });
    vi.setSystemTime(NOW + 2 * SECOND);
    await readIn(hostOf(scopeId, asked.fetchImpl));
    late.resolve(true);
    await Promise.all(lateBehind);

    await expect(readIn(hostOf(scopeId, asked.fetchImpl))).resolves.toStrictEqual({
      revision: 9,
      invalidatedAt: NOW + SECOND,
    });
  });

  it('is asked one question at a time, though one taken for lost answers after another went', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const scopeId = scopeOfItsOwn();
    const lost = Promise.withResolvers<true>();
    const questions = { asked: 0 };
    const answering: FetchLike = async (request) => {
      if (!new URL(request.url).pathname.endsWith('/tags/revision')) {
        return new Response('not the revision route', { status: 500 });
      }
      questions.asked += 1;
      if (questions.asked === 1) {
        await lost.promise;
        return new Response('the authority is out', { status: 503 });
      }
      return new Promise<Response>(() => {
        // The question asked again is still out when the test looks.
      });
    };
    const host = hostOf(scopeId, answering);
    const lostBehind: Promise<unknown>[] = [];

    await readLeaving(host, lostBehind);
    // Past the first question's lifetime: it is taken for lost, and another goes.
    vi.setSystemTime(NOW + 11 * SECOND);
    await readLeaving(host, []);
    lost.resolve(true);
    await Promise.all(lostBehind);
    // Past the hold, the copy still missing: the question out is the second's.
    vi.setSystemTime(NOW + 12 * SECOND);
    await readLeaving(host, []);

    expect(questions.asked).toBe(2);
  });

  it('is asked by one isolate of a data center at a time, the others leaving the question to it', async () => {
    const scopeId = scopeOfItsOwn();
    const gate = Promise.withResolvers<true>();
    const slow = slowAuthority(4, gate.promise);
    const firstBehind: Promise<unknown>[] = [];
    await readLeaving(hostOf(scopeId, slow.fetchImpl), firstBehind);
    await vi.waitFor(() => {
      expect(slow.asked()).toBe(1);
    });

    // The question is out: the data center's other isolates find no copy, and the claim.
    const othersBehind: Promise<unknown>[] = [];
    for (const other of [hostOf(scopeId, slow.fetchImpl), hostOf(scopeId, slow.fetchImpl)]) {
      await readLeaving(other, othersBehind);
    }
    gate.resolve(true);
    await Promise.all(firstBehind);
    await Promise.all(othersBehind);

    await expect(readIn(hostOf(scopeId, slow.fetchImpl))).resolves.toStrictEqual({
      revision: 4,
      invalidatedAt: NOW,
    });
    expect(slow.asked()).toBe(1);
  });

  it('is not kept from an answer that came back past its question’s claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const scopeId = scopeOfItsOwn();
    const late = Promise.withResolvers<true>();
    const slow = slowAuthority(5, late.promise);
    const lateBehind: Promise<unknown>[] = [];
    await readLeaving(hostOf(scopeId, slow.fetchImpl), lateBehind);
    await vi.waitFor(() => {
      expect(slow.asked()).toBe(1);
    });

    // Another isolate may have asked since the claim lapsed, and kept a later answer.
    vi.setSystemTime(NOW + 2 * SECOND);
    late.resolve(true);
    await Promise.all(lateBehind);

    const elsewhere = hostOf(scopeId, authority().fetchImpl);

    await expect(readIn(elsewhere)).resolves.toBeUndefined();
  });

  it('is asked again once a question claimed has gone unanswered past its claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const scopeId = scopeOfItsOwn();
    const never = Promise.withResolvers<true>();
    const slow = slowAuthority(4, never.promise);
    await readLeaving(hostOf(scopeId, slow.fetchImpl), []);
    await vi.waitFor(() => {
      expect(slow.asked()).toBe(1);
    });

    vi.setSystemTime(NOW + 2 * SECOND);
    await readLeaving(hostOf(scopeId, slow.fetchImpl), []);

    await vi.waitFor(() => {
      expect(slow.asked()).toBe(2);
    });
  });

  it('is found by no host that opens the scope with another token', async () => {
    const scopeId = scopeOfItsOwn();
    const asked = authority();
    asked.invalidate(4, NOW);
    await readIn(hostOf(scopeId, asked.fetchImpl));

    await expect(
      readIn(hostOf(scopeId, asked.fetchImpl, beaconHost, 'another-token')),
    ).resolves.toBeUndefined();
  });

  it('is kept by no host that does not ask for it', async () => {
    const scopeId = scopeOfItsOwn();
    const asked = authority();

    await expect(readIn(hostOf(scopeId, asked.fetchImpl, beaconlessHost))).resolves.toBeUndefined();
    expect(asked.asked()).toBe(0);
  });
});
