import { sha256Hex } from '@stayingupwind/core/artifact';
import { artifactIdFor } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArtifactCopies } from '../../../cache/src/function/artifacts.ts';
import { ReadBudget } from '../../../cache/src/function/read-budget.ts';
import type { CacheHost, FetchLike } from '../../src/cache/host.ts';
import { installRequestContext, withRequestContext } from '../../src/request-context.ts';
import { createCacheHost } from '../function-cache-host.ts';

/**
 * What a deployment's Worker keeps of the artifacts it reads through its cache host
 * (`upwind/packages/cache/src/function/artifacts.ts`): each isolate holds what it read, and its
 * data center keeps a copy in the Cache API, so an artifact already read is not read from the
 * authority again.
 *
 * Run inside workerd, since the Cache API is what is under test. The authority is a stand-in for the
 * one route these reads take; each test reads under a scope of its own, so no copy one test keeps
 * is found by another. A host made afresh stands for another isolate in the same data center.
 */

const GATEWAY_URL = 'https://authority.test';
const MIB = 1024 * 1024;

interface Artifact {
  readonly id: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

interface Authority {
  readonly fetchImpl: FetchLike;
  /** The artifacts the authority was asked for, in order. */
  readonly asked: string[];
}

interface InRequest<T> {
  readonly result: T;
  /** What the read handed to the request's `waitUntil`. */
  readonly handed: Promise<unknown>[];
}

function scopeOfItsOwn(): string {
  return `scope-${crypto.randomUUID()}`;
}

async function artifactOf(scopeId: string, bytes: Uint8Array<ArrayBuffer>): Promise<Artifact> {
  return { id: await artifactIdFor(scopeId, await sha256Hex(bytes)), bytes };
}

function textOf(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** `size` bytes of one value: artifacts large enough to fill the memory a test measures. */
function filled(size: number, value: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(size).fill(value);
}

function notFound(): Response {
  return Response.json(
    { ok: false, error: { code: 'not_found', message: 'no such artifact in the scope' } },
    { status: 404 },
  );
}

/** The authority's artifact route, answering from `stored`, and a 404 for what it does not hold. */
function authorityOf(stored: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): Authority {
  const asked: string[] = [];
  return {
    asked,
    fetchImpl: (request) => {
      const { pathname } = new URL(request.url);
      const artifactId = pathname.slice(pathname.lastIndexOf('/') + 1);
      asked.push(artifactId);
      const bytes = stored.get(artifactId);
      return Promise.resolve(
        bytes === undefined
          ? notFound()
          : new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }),
      );
    },
  };
}

/** An authority that refuses every read until it relents, and then answers as `authority` does. */
function refusingUntilRelented(authority: Authority): {
  readonly fetchImpl: FetchLike;
  readonly relent: () => void;
} {
  const state = { refusing: true };
  const refusal = (): Response => {
    authority.asked.push('refused');
    return Response.json(
      { ok: false, error: { code: 'scope_retired', message: 'the scope is retired' } },
      { status: 410 },
    );
  };
  return {
    relent: () => {
      state.refusing = false;
    },
    fetchImpl: (request) =>
      state.refusing ? Promise.resolve(refusal()) : authority.fetchImpl(request),
  };
}

/** The host a deployment's runtime is given, reaching the authority at a URL. */
function hostOf(scopeId: string, fetchImpl: FetchLike): CacheHost {
  const binding = createCacheHost({
    env: {
      ARKOR_CACHE_GATEWAY_URL: GATEWAY_URL,
      ARKOR_CACHE_TOKEN: 'test-scope-token',
      NEXT_DEPLOYMENT_ID: scopeId,
    },
    fetchImpl,
  });
  if (binding === undefined) {
    throw new Error('these bindings reach no cache');
  }
  return binding.host;
}

/**
 * A read by another isolate in the data center, whose authority holds nothing: only the copy can
 * answer it.
 */
function readElsewhere(scopeId: string, artifactId: string): Promise<Uint8Array | undefined> {
  return hostOf(scopeId, authorityOf(new Map()).fetchImpl).readArtifact(artifactId);
}

/** Run `work` as the runtime runs a request: with a `waitUntil` that keeps what it is handed. */
async function inRequest<T>(work: () => Promise<T>): Promise<InRequest<T>> {
  installRequestContext();
  const handed: Promise<unknown>[] = [];
  const result = await withRequestContext(
    {
      headers: {},
      url: 'https://app.test/',
      waitUntil: (promise) => {
        handed.push(promise);
      },
    },
    work,
  );
  return { result, handed };
}

/** A first isolate's read of an artifact, once the copy it keeps behind its response is written. */
async function readAndKeep(
  scopeId: string,
  artifact: Artifact,
): Promise<InRequest<Uint8Array | undefined>> {
  const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));
  const read = await inRequest(() =>
    hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id),
  );
  await Promise.all(read.handed);
  return read;
}

/** Put `match` in front of the data center's copies, and count the copies written through. */
function spyOnCopies(
  match: (cache: Cache, key: RequestInfo | URL) => Promise<Response | undefined>,
): {
  readonly puts: unknown[];
} {
  const puts: unknown[] = [];
  const open = caches.open.bind(caches);
  vi.spyOn(caches, 'open').mockImplementation(async (name: string) => {
    const cache = await open(name);
    const spied = {
      match: (key: RequestInfo | URL) => match(cache, key),
      put: async (key: RequestInfo | URL, response: Response) => {
        puts.push(key);
        await cache.put(key, response);
      },
    };
    return spied as unknown as Cache;
  });
  return { puts };
}

/** Make each of the data center's copies answer only `ms` after it is asked. */
function slowCopies(ms: number): { readonly puts: unknown[] } {
  return spyOnCopies(async (cache, key) => {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
    return cache.match(key);
  });
}

/**
 * Move the clock a millisecond at a time until `happened` holds, and no further: a deadline a read
 * sets past that moment stays where it is.
 */
async function advanceUntil(happened: () => boolean): Promise<void> {
  const limit = 1000;
  for (let step = 0; step < limit && !happened(); step += 1) {
    await vi.advanceTimersByTimeAsync(1);
  }
}

/** The URL a copy is kept under, however the Cache API was handed it. */
function keyUrl(key: RequestInfo | URL): string {
  if (typeof key === 'string') {
    return key;
  }
  return key instanceof URL ? key.href : key.url;
}

/** The copy of whichever of `artifacts` the key names, as the Cache API answers with one. */
function copyIn(artifacts: readonly Artifact[], key: RequestInfo | URL): Response | undefined {
  const kept = artifacts.find(({ id }) => keyUrl(key).endsWith(encodeURIComponent(id)));
  return kept === undefined ? undefined : new Response(kept.bytes);
}

/** What the reads of copies `serveCopies` answers came to. */
interface Served {
  /** The copies whose bodies were asked for, in the order they were. */
  readonly begun: string[];
  /** Bodies being read now, and the most that were at once. */
  readonly bodies: { out: number; most: number };
}

/**
 * Answer for each of `artifacts` as the data center's copy: saying how long it is where `stated`
 * holds for it, as a copy kept since copies say their length does, and its body coming once
 * `arrives` lets it — asked for only when it is read.
 */
function serveCopies(
  artifacts: readonly Artifact[],
  {
    stated = () => true,
    arrives = () => Promise.resolve(),
  }: {
    readonly stated?: (artifact: Artifact) => boolean;
    readonly arrives?: (artifact: Artifact) => Promise<void>;
  } = {},
): Served {
  const served: Served = { begun: [], bodies: { out: 0, most: 0 } };
  spyOnCopies((_cache, key) => {
    const artifact = artifacts.find(({ id }) => keyUrl(key).endsWith(encodeURIComponent(id)));
    if (artifact === undefined) {
      return Promise.resolve(undefined);
    }
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          served.begun.push(artifact.id);
          served.bodies.out += 1;
          served.bodies.most = Math.max(served.bodies.most, served.bodies.out);
          await arrives(artifact);
          controller.enqueue(artifact.bytes);
          controller.close();
          served.bodies.out -= 1;
        },
      },
      { highWaterMark: 0 },
    );
    const length = { 'content-length': String(artifact.bytes.byteLength) };
    return Promise.resolve(new Response(body, { headers: stated(artifact) ? length : {} }));
  });
  return served;
}

/** The authority as it answers outside the suites: saying how long each artifact is. */
function sayingLengths(authority: Authority): Authority {
  return {
    asked: authority.asked,
    fetchImpl: async (request) => {
      const answer = await authority.fetchImpl(request);
      if (!answer.ok) {
        return answer;
      }
      const bytes = new Uint8Array(await answer.arrayBuffer());
      return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } });
    },
  };
}

/**
 * How long a read that nothing should hold is given to answer, as a clock that is not faked counts:
 * far longer than it takes, and far shorter than the copy's read is held for (ten seconds).
 */
const ANSWERS_WITHIN_MS = 2000;

/** What `promise` comes to within `ANSWERS_WITHIN_MS`, if it does. */
async function soon<T>(promise: Promise<T>): Promise<T | 'still out'> {
  return Promise.race([
    promise,
    new Promise<'still out'>((resolve) => {
      setTimeout(() => {
        resolve('still out');
      }, ANSWERS_WITHIN_MS);
    }),
  ]);
}

describe('artifacts a deployment has read', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('holds an artifact it read, and does not ask the authority for it again', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('the RSC payload of a regenerated page'));
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));
    const host = hostOf(scopeId, authority.fetchImpl);

    // What a read holds, it holds behind its response.
    const first = await inRequest(() => host.readArtifact(artifact.id));
    await Promise.all(first.handed);
    const second = await inRequest(() => host.readArtifact(artifact.id));

    expect(first.result).toStrictEqual(artifact.bytes);
    expect(second.result).toStrictEqual(artifact.bytes);
    expect(authority.asked).toStrictEqual([artifact.id]);
    // Held in the isolate, it needs nothing behind the second response.
    expect(second.handed).toStrictEqual([]);
  });

  it('answers another isolate in the data center from the copy kept behind the first response', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a prefetch segment'));
    const kept = await readAndKeep(scopeId, artifact);

    // The copy is written behind the response, on the request's `waitUntil`.
    expect(kept.handed).toHaveLength(1);

    // A copy that answers within its head start is the whole read: the authority is never asked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const second = authorityOf(new Map());
    const read = await inRequest(() => hostOf(scopeId, second.fetchImpl).readArtifact(artifact.id));

    expect(read.result).toStrictEqual(artifact.bytes);
    expect(second.asked).toStrictEqual([]);
    // Nothing to write again: the copy is where it was.
    expect(read.handed).toStrictEqual([]);
  });

  it('keeps the copy all the same where no request is there to hand it to', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a Pages Router page’s data'));
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));

    await expect(
      hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id),
    ).resolves.toStrictEqual(artifact.bytes);

    await vi.waitFor(async () => {
      await expect(readElsewhere(scopeId, artifact.id)).resolves.toStrictEqual(artifact.bytes);
    });
  });

  it('serves bytes that do not hash to their id, and neither holds nor copies them', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Said, and checked below.
    });
    const copies = spyOnCopies((cache, key) => cache.match(key));
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('what was stored'));
    const answered = textOf('what came back');
    const authority = authorityOf(new Map([[artifact.id, answered]]));
    const host = hostOf(scopeId, authority.fetchImpl);

    const first = await inRequest(() => host.readArtifact(artifact.id));
    await Promise.all(first.handed);
    const second = await inRequest(() => host.readArtifact(artifact.id));
    await Promise.all(second.handed);

    // The authority's answer is what it was before anything kept one; it is only not kept.
    expect(first.result).toStrictEqual(answered);
    expect(second.result).toStrictEqual(answered);
    expect(authority.asked).toStrictEqual([artifact.id, artifact.id]);
    expect(copies.puts).toStrictEqual([]);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('does not hash to its id'));
  });

  // A read that hashes the authority's bytes before it answers never finishes here: it fails on the
  // timeout, which is kept short so that it says so soon.
  it(
    'answers with the authority’s bytes before it hashes them, and holds them once they hash',
    { timeout: 5000 },
    async () => {
      const scopeId = scopeOfItsOwn();
      const artifact = await artifactOf(scopeId, textOf('a data value too large to travel inline'));
      const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));
      const host = hostOf(scopeId, authority.fetchImpl);
      // No hash finishes until the read has answered.
      const answered = Promise.withResolvers<undefined>();
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
        await answered.promise;
        return digest(algorithm, data);
      });

      const first = await inRequest(() => host.readArtifact(artifact.id));
      answered.resolve(undefined);
      await Promise.all(first.handed);
      const second = await inRequest(() => host.readArtifact(artifact.id));

      expect(first.result).toStrictEqual(artifact.bytes);
      expect(second.result).toStrictEqual(artifact.bytes);
      expect(authority.asked).toStrictEqual([artifact.id]);
    },
  );

  it('holds neither a refusal nor a miss', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a data value too large to travel inline'));
    const stored = new Map<string, Uint8Array<ArrayBuffer>>();
    const authority = authorityOf(stored);
    const refusing = refusingUntilRelented(authority);
    const host = hostOf(scopeId, refusing.fetchImpl);

    await expect(inRequest(() => host.readArtifact(artifact.id))).rejects.toMatchObject({
      name: 'CacheHostError',
      status: 410,
    });

    refusing.relent();
    const missing = await inRequest(() => host.readArtifact(artifact.id));
    stored.set(artifact.id, artifact.bytes);
    const found = await inRequest(() => host.readArtifact(artifact.id));
    await Promise.all(found.handed);

    expect(missing.result).toBeUndefined();
    expect(found.result).toStrictEqual(artifact.bytes);
    expect(authority.asked).toStrictEqual(['refused', artifact.id, artifact.id]);
  });

  it('serves no copy that does not hash to its id, and keeps the authority’s in its place', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Said, and checked below.
    });
    // What the application's own code could have put under the key, in a cache it can open too.
    const copies = spyOnCopies(() => Promise.resolve(new Response('not the artifact')));
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('the RSC payload'));
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));

    const read = await inRequest(() =>
      hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id),
    );
    await Promise.all(read.handed);

    expect(read.result).toStrictEqual(artifact.bytes);
    expect(authority.asked).toStrictEqual([artifact.id]);
    expect(copies.puts).toHaveLength(1);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('copy does not hash to its id'));
  });

  /**
   * A copy is read whole before it is held to its id, and what the application's own code put under
   * the key may run past the isolate's memory. No artifact runs past 25 MiB: a copy that does is not
   * the artifact, and is read no further — not at all, where it says its length.
   */
  it.each([
    ['says its length', true],
    ['says nothing of its length', false],
  ])('reads a copy no further than any artifact runs when it %s', async (_said, declared) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // Said, and checked elsewhere.
    });
    const chunk = new Uint8Array(64 * 1024);
    // 32 MiB, past the largest artifact by more than the read goes past it.
    const length = 32 * 1024 * 1024;
    let pulled = 0;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= length) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const copies = spyOnCopies(() => {
      return Promise.resolve(
        new Response(oversized, {
          headers: declared ? { 'content-length': String(length) } : {},
        }),
      );
    });
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('the RSC payload'));
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));

    const read = await inRequest(() =>
      hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id),
    );
    await Promise.all(read.handed);

    expect(read.result).toStrictEqual(artifact.bytes);
    expect(copies.puts).toHaveLength(1);
    expect(pulled).toBeLessThanOrEqual(
      declared ? 2 * chunk.byteLength : 25 * 1024 * 1024 + 2 * chunk.byteLength,
    );
  });

  /**
   * An authority may be configured to keep artifacts past 25 MiB, which no copy is read for: one
   * kept would never be found, and every read the authority answered would write it again.
   */
  it('keeps no copy of an artifact longer than any copy is read', async () => {
    const copies = spyOnCopies((cache, key) => cache.match(key));
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, filled(25 * MIB + 1, 1));
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));

    const read = await inRequest(() =>
      hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id),
    );
    await Promise.all(read.handed);

    expect(read.result?.byteLength).toBe(artifact.bytes.byteLength);
    expect(copies.puts).toStrictEqual([]);
  });

  /**
   * A copy past its head start answers while the authority, asked beside it, is still out. The
   * authority's read is called off: its bytes would be neither held nor copied over the copy, and
   * would sit in memory beside the copy's until they had all come.
   */
  it('calls off the authority’s read once the copy has answered', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('the RSC payload'));
    // Read once, so that the data center has the copy the next read asks first.
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));
    const first = await inRequest(() =>
      hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id),
    );
    await Promise.all(first.handed);
    slowCopies(30);
    const signals: AbortSignal[] = [];
    const stalled: FetchLike = (request) => {
      signals.push(request.signal);
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new Error('called off'));
        });
      });
    };

    const read = await inRequest(() => hostOf(scopeId, stalled).readArtifact(artifact.id));

    expect(read.result).toStrictEqual(artifact.bytes);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  /**
   * A Cache API that fails only once it is slow as well fails every read that misses it, and is
   * said to, as one that fails in time is.
   */
  it('says what a copy past its budget came to when it fails', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Said, and checked below.
    });
    spyOnCopies(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      throw new Error('the Cache API failed late');
    });
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('the RSC payload'));
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));

    const read = await inRequest(() =>
      hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id),
    );
    await Promise.all(read.handed);

    expect(read.result).toStrictEqual(artifact.bytes);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('the Cache API failed late'));
  });

  /**
   * A copy that stalls — its lookup, or its body — is read for ten seconds at the most, a third of
   * what the runtime gives work behind a response: the authority's bytes are written in its place
   * within what is left, rather than the copy spending all of it and every later read finding it
   * stalled again.
   */
  it.each([
    [
      'its lookup',
      () => {
        return new Promise<Response | undefined>(() => {
          // The Cache API never answers.
        });
      },
    ],
    [
      'its body',
      () => {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start() {
                // Nothing ever comes.
              },
            }),
          ),
        );
      },
    ],
  ])('writes the authority’s bytes over a copy that stalls in %s', async (_where, stalled) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // The stall is said; checked elsewhere.
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const copies = spyOnCopies(stalled);
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('the RSC payload'));
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));

    const reading = inRequest(() => hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id));
    await vi.advanceTimersByTimeAsync(200);

    await expect(reading).resolves.toMatchObject({ result: artifact.bytes });
    expect(copies.puts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(copies.puts).toHaveLength(1);
  });

  /**
   * A request has six calls waiting for an answer at the most, and a lookup the Cache API stalls on
   * is one of them for as long as it stalls: a read gives up on it but cannot call it off. A
   * request's lookups are kept to two at once, so that those that stall leave the rest to the
   * authority's reads; past them a lookup waits its turn, and one still waiting once the read's
   * limit is past is never asked. Each request has turns of its own, as it has its own six.
   */
  it('keeps each request’s lookups of copies to two at once, and answers the rest from the authority', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // The stalls are said; checked elsewhere.
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scopeId = scopeOfItsOwn();
    const artifacts = await Promise.all(
      ['one', 'two', 'three'].map(async (name) => artifactOf(scopeId, textOf(`segment ${name}`))),
    );
    const lookups: unknown[] = [];
    // The Cache API answers each lookup only once the read's limit is past.
    spyOnCopies(async (_cache, key) => {
      lookups.push(key);
      await new Promise((resolve) => {
        setTimeout(resolve, 10_500);
      });
      return copyIn(artifacts, key);
    });
    const authority = authorityOf(new Map(artifacts.map(({ id, bytes }) => [id, bytes])));
    // Each request a host of its own, as the isolates a data center runs have.
    const readAll = async (): Promise<InRequest<(Uint8Array | undefined)[]>> => {
      const host = hostOf(scopeId, authority.fetchImpl);
      return inRequest(async () =>
        Promise.all(artifacts.map(async ({ id }) => host.readArtifact(id))),
      );
    };

    const reading = Promise.all([readAll(), readAll()]);
    await vi.advanceTimersByTimeAsync(200);
    const answered = await reading;

    for (const read of answered) {
      expect(read.result).toStrictEqual(artifacts.map(({ bytes }) => bytes));
    }

    expect(lookups).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(11_000);

    expect(lookups).toHaveLength(4);
  });

  it('asks a lookup that waited its turn once one before it has answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scopeId = scopeOfItsOwn();
    const artifacts = await Promise.all(
      ['one', 'two', 'three'].map(async (name) => artifactOf(scopeId, textOf(`segment ${name}`))),
    );
    const lookups: unknown[] = [];
    // Each copy is there, and answers 4 ms after it is asked.
    spyOnCopies(async (_cache, key) => {
      lookups.push(key);
      await new Promise((resolve) => {
        setTimeout(resolve, 4);
      });
      return copyIn(artifacts, key);
    });
    // An authority that holds nothing: only the copies can answer.
    const host = hostOf(scopeId, authorityOf(new Map()).fetchImpl);

    const reading = inRequest(async () =>
      Promise.all(artifacts.map(async ({ id }) => host.readArtifact(id))),
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(lookups).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(20);

    expect(lookups).toHaveLength(3);
    await expect(reading).resolves.toMatchObject({
      result: artifacts.map(({ bytes }) => bytes),
    });
  });

  /**
   * The copies a request keeps are written behind its response, but beside the rest of its render:
   * one at a time, so that a burst of them, or one that stalls, does not hold that render's calls.
   */
  it('writes the copies one request keeps one at a time', async () => {
    const written: string[] = [];
    const held: (() => void)[] = [];
    // No copy is there, and each write is held until it is let go.
    const copies = {
      match: () => Promise.resolve(),
      put: async (key: RequestInfo | URL, response: Response) => {
        written.push(keyUrl(key));
        await response.arrayBuffer();
        await new Promise<void>((resolve) => {
          held.push(resolve);
        });
      },
    };
    vi.spyOn(caches, 'open').mockResolvedValue(copies as unknown as Cache);
    const scopeId = scopeOfItsOwn();
    const artifacts = await Promise.all(
      ['one', 'two', 'three'].map(async (name) => artifactOf(scopeId, textOf(`value ${name}`))),
    );
    const authority = authorityOf(new Map(artifacts.map(({ id, bytes }) => [id, bytes])));
    const host = hostOf(scopeId, authority.fetchImpl);

    const read = await inRequest(async () =>
      Promise.all(artifacts.map(async ({ id }) => host.readArtifact(id))),
    );
    await vi.waitFor(() => {
      expect(written).toHaveLength(1);
    });
    // A moment more, in which no other write is begun while the first is out.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(written).toHaveLength(1);

    for (const count of [2, 3]) {
      held.shift()?.();
      await vi.waitFor(() => {
        expect(written).toHaveLength(count);
      });
    }
    held.shift()?.();
    await Promise.all(read.handed);

    expect(read.result).toStrictEqual(artifacts.map(({ bytes }) => bytes));
  });

  it('takes a Cache API that fails for a miss, never for an error', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Said, and checked below.
    });
    vi.spyOn(caches, 'open').mockRejectedValue(new Error('the Cache API is unavailable'));
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a prefetch segment'));
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));

    const read = await inRequest(() =>
      hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id),
    );
    await Promise.all(read.handed);

    expect(read.result).toStrictEqual(artifact.bytes);
    expect(authority.asked).toStrictEqual([artifact.id]);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('artifact copy read failed'));
  });

  // A read that does not ask the authority while the copy is out never finishes here: it fails on
  // the timeout, which is kept short so that it says so soon.
  it(
    'asks the authority beside a copy slower than its head start, and serves the copy that answers first',
    { timeout: 5000 },
    async () => {
      const scopeId = scopeOfItsOwn();
      const artifact = await artifactOf(scopeId, textOf('the RSC payload'));
      await readAndKeep(scopeId, artifact);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      // The copy answers only once the authority has been asked, and the authority not before the
      // read is over: only a read that asked the authority while the copy was out can finish.
      const asked = Promise.withResolvers<undefined>();
      const authority = Promise.withResolvers<Response>();
      const state = { asked: false };
      spyOnCopies(async (cache, key) => {
        await asked.promise;
        return cache.match(key);
      });
      const host = hostOf(scopeId, () => {
        state.asked = true;
        asked.resolve(undefined);
        return authority.promise;
      });

      const reading = host.readArtifact(artifact.id);
      await advanceUntil(() => state.asked);
      const read = await reading;
      authority.resolve(notFound());

      expect(state.asked).toBe(true);
      expect(read).toStrictEqual(artifact.bytes);
    },
  );

  it('throws the authority’s refusal when a copy slower than its head start then misses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Past the 10 ms head start, and within the 100 ms budget.
    const copies = slowCopies(30);
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a prefetch segment'));
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));
    const refusing = refusingUntilRelented(authority);

    // What the read threw, taken as it happens and asserted once the clock is through.
    const refusal = (async (): Promise<unknown> => {
      try {
        await inRequest(() => hostOf(scopeId, refusing.fetchImpl).readArtifact(artifact.id));
        return 'answered';
      } catch (error) {
        return error;
      }
    })();
    await vi.advanceTimersByTimeAsync(50);

    await expect(refusal).resolves.toMatchObject({ name: 'CacheHostError', status: 410 });

    expect(authority.asked).toStrictEqual(['refused']);
    expect(copies.puts).toStrictEqual([]);
  });

  /**
   * Bytes of the id are the artifact whoever holds them. Where the authority refuses, a copy past its
   * budget that turns up within a moment more answers in place of the refusal, and is held.
   */
  it('serves a copy past its budget that turns up after the authority refused', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a data value too large to travel inline'));
    await readAndKeep(scopeId, artifact);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Three times the 100 ms a read waits on the copy, and well within the grace past it.
    slowCopies(300);
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));
    const refusing = refusingUntilRelented(authority);
    const host = hostOf(scopeId, refusing.fetchImpl);

    const reading = inRequest(() => host.readArtifact(artifact.id));
    await vi.advanceTimersByTimeAsync(400);
    const read = await reading;
    const again = await inRequest(() => host.readArtifact(artifact.id));

    expect(read.result).toStrictEqual(artifact.bytes);
    // Held: the second read asks neither the copy's budget nor the authority.
    expect(again.result).toStrictEqual(artifact.bytes);
    expect(authority.asked).toStrictEqual(['refused']);
  });

  it('throws the authority’s refusal when a copy past its budget turns up after the grace too', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a data value too large to travel inline'));
    await readAndKeep(scopeId, artifact);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Past the 100 ms budget and the second after it.
    slowCopies(1500);
    const refusing = refusingUntilRelented(authorityOf(new Map([[artifact.id, artifact.bytes]])));

    const refusal = (async (): Promise<unknown> => {
      try {
        await inRequest(() => hostOf(scopeId, refusing.fetchImpl).readArtifact(artifact.id));
        return 'answered';
      } catch (error) {
        return error;
      }
    })();
    await vi.advanceTimersByTimeAsync(1200);

    await expect(refusal).resolves.toMatchObject({ name: 'CacheHostError', status: 410 });

    await vi.advanceTimersByTimeAsync(400);
  });

  /**
   * A copy past its budget that turns up after the read has its answer — here, the refusal past
   * the grace — is still the artifact. It is handed to the request's `waitUntil` so that the runtime
   * lets it land, and held once it does.
   */
  it('keeps a copy past its budget going behind the answer, and holds it when it turns up', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a data value too large to travel inline'));
    await readAndKeep(scopeId, artifact);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Past the 100 ms budget and the second after it.
    slowCopies(1500);
    const refusing = refusingUntilRelented(authorityOf(new Map([[artifact.id, artifact.bytes]])));
    const host = hostOf(scopeId, refusing.fetchImpl);
    installRequestContext();
    const handed: Promise<unknown>[] = [];
    const context = {
      headers: {},
      url: 'https://app.test/',
      waitUntil: (promise: Promise<unknown>) => {
        handed.push(promise);
      },
    };

    const refusal = (async (): Promise<unknown> => {
      try {
        await withRequestContext(context, () => host.readArtifact(artifact.id));
        return 'answered';
      } catch (error) {
        return error;
      }
    })();
    await vi.advanceTimersByTimeAsync(1200);

    await expect(refusal).resolves.toMatchObject({ name: 'CacheHostError', status: 410 });
    expect(handed).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(400);
    await Promise.all(handed);

    // Held: answered with no copy read and no authority asked.
    await expect(host.readArtifact(artifact.id)).resolves.toStrictEqual(artifact.bytes);
  });

  /**
   * A copy past its budget that turns up while the authority is still out answers: the read is not
   * kept waiting on an authority that stalls when the artifact is already here.
   */
  it('serves a copy past its budget that turns up while the authority stalls', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a data value too large to travel inline'));
    await readAndKeep(scopeId, artifact);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Three times the 100 ms a read waits on the copy; the authority answers only after a minute.
    slowCopies(300);
    const host = hostOf(scopeId, async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 60_000);
      });
      return notFound();
    });

    const state = { answered: false };
    const reading = (async () => {
      const read = await inRequest(() => host.readArtifact(artifact.id));
      state.answered = true;
      return read;
    })();
    await vi.advanceTimersByTimeAsync(400);

    expect(state.answered).toBe(true);
    await expect(reading).resolves.toMatchObject({ result: artifact.bytes });

    await vi.advanceTimersByTimeAsync(60_000);
  });

  /**
   * The copy's budget covers holding it to its id as well as reading it: a large copy can take
   * seconds to hash on a busy isolate, and a read whose authority has answered meanwhile waits for
   * it no longer than the budget and the grace after it — not for as long as the hash takes.
   */
  it('waits for a copy still being held to its id no longer than its budget and the grace', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a data value too large to travel inline'));
    await readAndKeep(scopeId, artifact);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    slowCopies(60);
    // Each digest a hash of the copy takes waits a second: the copy is read by 60 ms and held to
    // its id two seconds after, while the authority answers at once that it has nothing.
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
      return digest(algorithm, data);
    });
    const host = hostOf(scopeId, authorityOf(new Map()).fetchImpl);
    const state = { answered: false };
    const reading = (async () => {
      const read = await inRequest(() => host.readArtifact(artifact.id));
      state.answered = true;
      return read;
    })();
    await vi.advanceTimersByTimeAsync(1200);

    // The budget and the grace are spent by 1.1 s, the hash two seconds out: the read is over.
    expect(state.answered).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);

    await expect(reading).resolves.toMatchObject({ result: undefined });
  });

  it('serves the authority’s bytes when they come first, and writes nothing over the copy that then answers', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('the RSC payload'));
    await readAndKeep(scopeId, artifact);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const copies = slowCopies(30);
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));

    const reading = inRequest(() => hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id));
    await vi.advanceTimersByTimeAsync(50);
    const read = await reading;
    await Promise.all(read.handed);

    expect(read.result).toStrictEqual(artifact.bytes);
    expect(authority.asked).toStrictEqual([artifact.id]);
    expect(copies.puts).toStrictEqual([]);
  });

  it('answers none and keeps nothing when a copy slower than its head start and the authority both miss', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const copies = slowCopies(30);
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a Pages Router page’s data'));
    const authority = authorityOf(new Map());
    const host = hostOf(scopeId, authority.fetchImpl);

    const first = inRequest(() => host.readArtifact(artifact.id));
    await vi.advanceTimersByTimeAsync(50);
    const missing = await first;
    const second = inRequest(() => host.readArtifact(artifact.id));
    await vi.advanceTimersByTimeAsync(50);
    await second;

    expect(missing.result).toBeUndefined();
    expect(missing.handed).toStrictEqual([]);
    expect(copies.puts).toStrictEqual([]);
    // Nothing held: the second read asks the authority again.
    expect(authority.asked).toStrictEqual([artifact.id, artifact.id]);
  });

  it('takes a copy slower than its budget for a miss unremarked, and does not write over it when it turns up', async () => {
    const warned = vi.spyOn(console, 'warn');
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a data value too large to travel inline'));
    await readAndKeep(scopeId, artifact);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The copy is there, but its body takes three times the 100 ms a read waits on it.
    const copies = slowCopies(300);
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));

    const reading = inRequest(() => hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id));
    await vi.advanceTimersByTimeAsync(400);
    const read = await reading;
    await Promise.all(read.handed);

    expect(read.result).toStrictEqual(artifact.bytes);
    expect(authority.asked).toStrictEqual([artifact.id]);
    expect(copies.puts).toStrictEqual([]);
    expect(warned).not.toHaveBeenCalled();
  });

  it('copies the authority’s bytes where a copy slower than its budget turns out to be missing', async () => {
    const warned = vi.spyOn(console, 'warn');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const copies = slowCopies(300);
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a data value too large to travel inline'));
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));

    const reading = inRequest(() => hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id));
    await vi.advanceTimersByTimeAsync(400);
    const read = await reading;
    await Promise.all(read.handed);

    expect(read.result).toStrictEqual(artifact.bytes);
    expect(copies.puts).toHaveLength(1);
    expect(warned).not.toHaveBeenCalled();
  });

  it('writes over a copy slower than its budget that turns up as something else', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // A copy the application's own code wrote under the key: it answers, but three times past the
    // 100 ms a read waits on it, and its bytes are not the artifact's.
    const copies = spyOnCopies(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      return new Response('not the artifact');
    });
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, textOf('a data value too large to travel inline'));
    const authority = authorityOf(new Map([[artifact.id, artifact.bytes]]));

    const reading = inRequest(() => hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id));
    await vi.advanceTimersByTimeAsync(400);
    const read = await reading;
    await Promise.all(read.handed);

    expect(read.result).toStrictEqual(artifact.bytes);
    expect(copies.puts).toHaveLength(1);
  });

  it('holds no more than its budget, and no one artifact over a quarter of it', async () => {
    // No Cache API, as where the suites run the runtime under Node: only memory keeps anything.
    vi.stubGlobal('caches', undefined);
    const scopeId = scopeOfItsOwn();
    const large = await artifactOf(scopeId, filled(3 * MIB, 1));
    const several = await Promise.all(
      [2, 3, 4, 5, 6, 7].map((value) => artifactOf(scopeId, filled(1.5 * MIB, value))),
    );
    const stored = new Map([large, ...several].map((artifact) => [artifact.id, artifact.bytes]));
    const authority = authorityOf(stored);
    const host = hostOf(scopeId, authority.fetchImpl);
    // Each read, once what it holds behind its response is held.
    const readThrough = async (artifactId: string): Promise<void> => {
      const read = await inRequest(() => host.readArtifact(artifactId));
      await Promise.all(read.handed);
    };

    await readThrough(large.id);
    await readThrough(large.id);
    for (const artifact of several) {
      await readThrough(artifact.id);
    }
    const [oldest] = several;
    const newest = several.at(-1);
    await readThrough(newest!.id);
    await readThrough(oldest!.id);

    // The large one is read every time; of the rest, the newest is still held, the oldest is not.
    expect(authority.asked.filter((id) => id === large.id)).toHaveLength(2);
    expect(authority.asked.filter((id) => id === newest!.id)).toHaveLength(1);
    expect(authority.asked.filter((id) => id === oldest!.id)).toHaveLength(2);
  });
});

/**
 * A copy is read whole, as the authority's answer is, and an artifact too large for an isolate to
 * hold is read whole from its copy every time: an isolate reads no more of them at once than it has
 * room for, 32 MiB of copies and the authority's answers together (`packages/cache-host`). A copy
 * that says how long it is takes its room before its body is read, and the authority's answer asked
 * beside it is read in that room; a copy kept before copies said their length is read as it was.
 */
describe('the room an isolate reads artifacts in', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps a large authority body behind room already held when its short-stated copy stalls', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // The stalled copy closes without the artifact once the read has its answer.
    });
    const budget = new ReadBudget(32);
    const other = await budget.take(24, new AbortController().signal);
    let finishCopy: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finishCopy = () => {
          controller.close();
        };
      },
    });
    vi.spyOn(caches, 'open').mockResolvedValue({
      match: () => Promise.resolve(new Response(body, { headers: { 'content-length': '1' } })),
    } as unknown as Cache);
    let readingAuthority = false;
    const copies = new ArtifactCopies(
      'scope',
      async (_id, signal, room) => {
        const release = await room!.hold(16, signal!);
        readingAuthority = true;
        release();
        return new Uint8Array(16);
      },
      { copyCache: 'artifact-room', copyKeyOrigin: 'https://copy.invalid' },
      budget,
    );

    const reading = copies.read('artifact');
    await vi.advanceTimersByTimeAsync(20);
    const whileTheOtherReadHolds = readingAuthority;
    other();
    await vi.advanceTimersByTimeAsync(100);
    const answer = await reading;
    finishCopy?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(whileTheOtherReadHolds).toBe(false);
    expect(readingAuthority).toBe(true);
    expect(answer?.byteLength).toBe(16);
  });

  it.each([0, MIB])('gives up a copy that runs past its stated %i bytes', async (declared) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // An invalid copy is discarded and replaced by the authority's bytes.
    });
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, filled(4 * MIB, 7));
    const chunkBytes = 64 * 1024;
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = artifact.bytes.subarray(pulled, pulled + chunkBytes);
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
          if (pulled === artifact.bytes.byteLength) {
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const copies = spyOnCopies(() =>
      Promise.resolve(new Response(body, { headers: { 'content-length': String(declared) } })),
    );
    const authority = sayingLengths(authorityOf(new Map([[artifact.id, artifact.bytes]])));

    const read = await inRequest(() =>
      hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id),
    );
    await Promise.all(read.handed);

    expect([read.result?.byteLength, read.result?.[0]]).toStrictEqual([4 * MIB, 7]);
    expect(pulled).toBeLessThanOrEqual(declared + 2 * chunkBytes);
    expect(cancelled).toBe(true);
    expect(authority.asked).toStrictEqual([artifact.id]);
    expect(copies.puts).toHaveLength(1);
  });

  it('keeps a copy that says how long it is', async () => {
    const said: (string | null | undefined)[] = [];
    spyOnCopies(async (cache, key) => {
      const hit = await cache.match(key);
      said.push(hit?.headers.get('content-length'));
      return hit;
    });
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, filled(MIB, 8));

    await readAndKeep(scopeId, artifact);
    const elsewhere = await readElsewhere(scopeId, artifact.id);

    expect(elsewhere?.byteLength).toBe(MIB);
    // The first read found no copy; the one it kept behind its response says its length.
    expect(said).toStrictEqual([undefined, String(MIB)]);
  });

  it('reads no more copies at once than it has room for, and the rest as room is given back', async () => {
    const scopeId = scopeOfItsOwn();
    const artifacts = await Promise.all(
      [1, 2, 3].map(async (value) => artifactOf(scopeId, filled(12 * MIB, value))),
    );
    // Each body takes a moment to come, so that reads begun together are read together.
    const served = serveCopies(artifacts, {
      arrives: async () => {
        return new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      },
    });
    // An authority that holds nothing: only the copies can answer.
    const host = hostOf(scopeId, authorityOf(new Map()).fetchImpl);

    const read = await inRequest(async () =>
      Promise.all(artifacts.map(async ({ id }) => host.readArtifact(id))),
    );

    // Two of 12 MiB fit in 32 at once; the third is read once one of them gives its room back.
    expect(served.bodies.most).toBe(2);
    expect(read.result.map((bytes) => [bytes?.byteLength, bytes?.[0]])).toStrictEqual([
      [12 * MIB, 1],
      [12 * MIB, 2],
      [12 * MIB, 3],
    ]);
  });

  it('reads a copy read alone at once, however long a copy may be', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, filled(25 * MIB, 9));
    const served = serveCopies([artifact]);
    const authority = authorityOf(new Map());

    // No timer runs: a read that waited for room, or for anything on a clock, would not answer.
    const read = await inRequest(() =>
      hostOf(scopeId, authority.fetchImpl).readArtifact(artifact.id),
    );

    expect([read.result?.byteLength, read.result?.[0]]).toStrictEqual([25 * MIB, 9]);
    expect(served.begun).toStrictEqual([artifact.id]);
    expect(authority.asked).toStrictEqual([]);
  });

  /**
   * The authority is asked beside a copy slower than its head start, for the same bytes. Read in
   * room of its own, its answer would wait behind a copy that stalls with its room taken, which is
   * the very wait it is asked to spare the read.
   */
  it('reads the authority’s answer beside a copy that stalls in the copy’s room', async () => {
    const scopeId = scopeOfItsOwn();
    const artifact = await artifactOf(scopeId, filled(20 * MIB, 4));
    const stalled = Promise.withResolvers<undefined>();
    serveCopies([artifact], { arrives: async () => stalled.promise });
    const authority = sayingLengths(authorityOf(new Map([[artifact.id, artifact.bytes]])));
    const host = hostOf(scopeId, authority.fetchImpl);

    const reading = inRequest(() => host.readArtifact(artifact.id));
    // Another 20 MiB beside the copy's 20 would not fit in the isolate's 32.
    const answered = await soon(reading);
    stalled.resolve(undefined);
    const read = await reading;
    await Promise.all(read.handed);

    expect(answered).not.toBe('still out');
    expect([read.result?.byteLength, read.result?.[0]]).toStrictEqual([20 * MIB, 4]);
    expect(authority.asked).toStrictEqual([artifact.id]);
  });

  it('reads a copy kept without its length as it always was, whatever room is left', async () => {
    const scopeId = scopeOfItsOwn();
    const holding = await artifactOf(scopeId, filled(25 * MIB, 5));
    const unsaid = await artifactOf(scopeId, filled(10 * MIB, 6));
    const stalled = Promise.withResolvers<undefined>();
    const served = serveCopies([holding, unsaid], {
      stated: (artifact) => artifact === holding,
      arrives: async (artifact) => (artifact === holding ? stalled.promise : undefined),
    });
    const host = hostOf(scopeId, authorityOf(new Map()).fetchImpl);

    // The first copy takes 25 MiB of the isolate's 32, and its body does not come.
    const first = inRequest(() => host.readArtifact(holding.id));
    await vi.waitFor(() => {
      expect(served.begun).toStrictEqual([holding.id]);
    });
    const answered = await soon(inRequest(() => host.readArtifact(unsaid.id)));
    stalled.resolve(undefined);
    await Promise.all((await first).handed);

    // Another 10 MiB would not fit beside it; said no length, the copy is read outside the room.
    expect(answered === 'still out' ? answered : answered.result?.byteLength).toBe(10 * MIB);
  });
});
