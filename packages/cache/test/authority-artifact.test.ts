import { sha256Hex } from '@stayingupwind/core/artifact';
import { artifactIdFor, cacheArtifactRefSchema } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseVars } from '../src/env.ts';
import { within } from '../src/function/artifacts.ts';
import { Gateway } from '../src/function/gateway.ts';
import { ArtifactRoom, functionReadBudget } from '../src/function/read-budget.ts';

const LIMIT = 32 * 1024 * 1024;
const COPY_LIMIT = 25 * 1024 * 1024;
const CHUNK = 64 * 1024;
const BYTES = new TextEncoder().encode('an artifact');
const SCOPE = 'scope_artifact_capacity';

function gateway(fetch: () => Promise<Response>) {
  return new Gateway({
    scopeId: SCOPE,
    gatewayUrl: 'https://cache.example',
    token: 'token',
    naming: { copyCache: crypto.randomUUID(), copyKeyOrigin: 'https://copy.example' },
    fetchImpl: fetch,
  });
}

async function idFor(bytes: Uint8Array = BYTES): Promise<string> {
  return artifactIdFor(SCOPE, await sha256Hex(bytes));
}

function nativeBody(source: UnderlyingSource<Uint8Array>): ReadableStream<Uint8Array> {
  Reflect.set(source, 'type', 'bytes');
  return new ReadableStream<Uint8Array>(source);
}

function chunks(size: number) {
  let sent = 0;
  const cancel = vi.fn();
  const body = nativeBody({
    pull(controller) {
      const length = Math.min(CHUNK, size - sent);
      if (length === 0) {
        controller.close();
      } else {
        sent += length;
        controller.enqueue(new Uint8Array(length));
      }
    },
    cancel,
  });
  return { body, cancel, sent: () => sent };
}

function takeRoom(): () => void {
  const release = functionReadBudget().takeAtOnce(LIMIT);
  if (release === undefined) throw new Error('test room was not empty');
  return release;
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function copiesThatStall() {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const matched = Promise.withResolvers<true>();
  const cache = {
    match: () => {
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controllers.push(controller);
          },
        },
        { highWaterMark: 0 },
      );
      if (controllers.length === 2) matched.resolve(true);
      return Promise.resolve(
        new Response(body, { headers: { 'content-length': String(BYTES.byteLength) } }),
      );
    },
    delete: () => Promise.resolve(false),
    put: async (_key: RequestInfo, response: Response) => {
      await response.arrayBuffer();
    },
  } as Cache;
  return {
    cache,
    matched: matched.promise,
    stop() {
      for (const controller of controllers) controller.error(new Error('copy fixture ended'));
    },
  };
}

describe('the Function whole-artifact read ceiling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps seeded references and configured-high uploads admissible', () => {
    const byteLength = LIMIT + 1;
    const parsed = cacheArtifactRefSchema.safeParse({
      artifactId: 'seeded-artifact',
      sha256: 'a'.repeat(64),
      byteLength,
      contentType: 'text/x-component',
      encoding: 'identity',
      role: 'rsc',
      storageRef: 'build/large-rsc',
    });

    expect(parsed.success).toBe(true);
    expect(parseVars({ MAX_ARTIFACT_BYTES: byteLength }).MAX_ARTIFACT_BYTES).toBe(byteLength);
  });

  it('misses an oversized declared artifact without pulling its body', async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(BYTES);
      controller.close();
    });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { 'content-length': String(LIMIT + 1) },
    });

    const bytes = await gateway(() => Promise.resolve(response)).readArtifact(await idFor());

    expect(bytes).toBeUndefined();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 1])(
    'misses a native artifact differing from its declared size by %i',
    async (delta) => {
      const response = new Response(BYTES, {
        headers: { 'content-length': String(BYTES.byteLength + delta) },
      });

      const bytes = await gateway(() => Promise.resolve(response)).readArtifact(await idFor());

      expect(bytes).toBeUndefined();
    },
  );

  it('bounds an artifact with no length instead of buffering it to EOF', async () => {
    const source = chunks(LIMIT + 1024 * 1024);
    const bytes = await gateway(() => Promise.resolve(new Response(source.body))).readArtifact(
      await idFor(),
    );

    // A boolean keeps a failed old implementation's large payload out of the test RPC.
    const missing = bytes === undefined;

    expect(missing).toBe(true);
    expect(source.sent()).toBeLessThanOrEqual(LIMIT + CHUNK);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('uses one native byte read and returns its exact view without arrayBuffer', async () => {
    const sample = new Response(BYTES);
    const sampleReader = sample.body!.getReader({ mode: 'byob' });
    const prototype = Object.getPrototypeOf(sampleReader) as ReadableStreamBYOBReader;
    sampleReader.releaseLock();
    const read = vi.spyOn(prototype, 'readAtLeast');
    const buffered = vi.spyOn(Response.prototype, 'arrayBuffer');
    const response = new Response(BYTES, {
      headers: { 'content-length': String(BYTES.byteLength) },
    });

    const bytes = await gateway(() => Promise.resolve(response)).readArtifact(await idFor());

    expect(bytes).toStrictEqual(BYTES);
    expect(bytes?.buffer.byteLength).toBe(BYTES.byteLength + 1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(buffered).not.toHaveBeenCalled();
  });

  it('accepts a native artifact at the ceiling', async () => {
    const source = chunks(LIMIT);
    const response = new Response(source.body, { headers: { 'content-length': String(LIMIT) } });
    const bytes = await gateway(() => Promise.resolve(response)).readArtifact(await idFor());

    expect(bytes?.byteLength).toBe(LIMIT);
    expect(source.sent()).toBe(LIMIT);
    expect(source.cancel).not.toHaveBeenCalled();
  });

  it('retains empty and generic adapter bodies', async () => {
    const empty = await gateway(() => Promise.resolve(new Response(null))).readArtifact(
      await idFor(new Uint8Array()),
    );
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(BYTES);
          controller.close();
        },
      }),
      { headers: { 'content-length': String(BYTES.byteLength) } },
    );
    const generic = await gateway(() => Promise.resolve(response)).readArtifact(await idFor());

    expect(empty?.byteLength).toBe(0);
    expect(generic).toStrictEqual(BYTES);
  });

  it('misses and cancels a generic adapter body exceeding its declared size', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(BYTES);
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
      { headers: { 'content-length': '1' } },
    );
    const bytes = await gateway(() => Promise.resolve(response)).readArtifact(await idFor());

    expect(bytes).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('holds the same shared room until its owned read settles', async () => {
    const release = takeRoom();
    const served = Promise.withResolvers<undefined>();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(BYTES);
      controller.close();
    });
    const response = new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), {
      headers: { 'content-length': String(BYTES.byteLength) },
    });
    const read = gateway(() => {
      served.resolve(undefined);
      return Promise.resolve(response);
    }).readArtifact(await idFor());
    try {
      await served.promise;
      await nextTurn();

      expect(pull).not.toHaveBeenCalled();

      release();

      await expect(read).resolves.toStrictEqual(BYTES);
    } finally {
      release();
      await read;
    }
  });

  it('reads an equal-sized authority answer while two copies compete for the remaining room', async () => {
    const id = await idFor();
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockReturnValue();
    const copies = copiesThatStall();
    vi.spyOn(caches, 'open').mockResolvedValue(copies.cache);
    // Other reads leave exactly two payloads of room, without allocating their bodies here.
    const releaseOther = functionReadBudget().takeAtOnce(LIMIT - 2 * BYTES.byteLength);
    if (releaseOther === undefined) throw new Error('test room was not empty');
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(BYTES, { headers: { 'content-length': String(BYTES.byteLength) } }),
      ),
    );
    const host = gateway(fetch);
    const reads = [host.readArtifact(id), host.readArtifact(id)];
    const settled = Promise.allSettled(reads);
    const first = within(Promise.race(reads), 100);
    try {
      await copies.matched;
      await vi.advanceTimersByTimeAsync(100);

      await expect(first).resolves.toStrictEqual(BYTES);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      copies.stop();
      releaseOther();
      await vi.advanceTimersByTimeAsync(10_100);
      await settled;
    }

    const release = takeRoom();
    release();
  });

  it('returns copy and authority room after deadlines without awaiting cancellation acknowledgement', async () => {
    const id = await idFor();
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockReturnValue();
    const copies = copiesThatStall();
    vi.spyOn(caches, 'open').mockResolvedValue(copies.cache);
    const releaseOther = functionReadBudget().takeAtOnce(LIMIT - 2 * BYTES.byteLength);
    if (releaseOther === undefined) throw new Error('test room was not empty');
    const acknowledgement = Promise.withResolvers<undefined>();
    const cancel = vi.fn(() => acknowledgement.promise);
    const host = gateway(() =>
      Promise.resolve(
        new Response(nativeBody({ cancel }), {
          headers: { 'content-length': String(BYTES.byteLength) },
        }),
      ),
    );
    const settled = Promise.allSettled([host.readArtifact(id), host.readArtifact(id)]);
    try {
      await copies.matched;
      await vi.advanceTimersByTimeAsync(10_100);

      await expect(settled).resolves.toMatchObject([
        { status: 'rejected' },
        { status: 'rejected' },
      ]);
      expect(cancel).toHaveBeenCalledTimes(2);

      const release = functionReadBudget().takeAtOnce(2 * BYTES.byteLength);

      expect(release).toBeTypeOf('function');

      release?.();
    } finally {
      copies.stop();
      acknowledgement.resolve(undefined);
      releaseOther();
      await vi.advanceTimersByTimeAsync(10_100);
      await settled;
    }
  });

  it.each(['resolved', 'pending', 'rejected'] as const)(
    'cancels a timed-out native consumer without waiting for %s acknowledgement',
    async (acknowledgment) => {
      vi.useFakeTimers();
      const ack = Promise.withResolvers<undefined>();
      const started = Promise.withResolvers<undefined>();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const cancel = vi.fn(() => {
        if (acknowledgment === 'resolved') ack.resolve(undefined);
        else if (acknowledgment === 'rejected') ack.reject(new Error('cancel failed'));
        return ack.promise;
      });
      const body = nativeBody({
        start(given) {
          controller = given;
        },
        pull() {
          started.resolve(undefined);
        },
        cancel,
      });
      const id = await idFor();
      const reading = gateway(() => Promise.resolve(new Response(body))).readArtifact(id);
      const result = Promise.allSettled([reading]);
      try {
        await started.promise;
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(result).resolves.toMatchObject([{ status: 'rejected' }]);
        expect(cancel).toHaveBeenCalledTimes(1);

        const room = functionReadBudget().takeAtOnce(LIMIT);

        expect(room).toBeTypeOf('function');

        room?.();
      } finally {
        ack.resolve(undefined);
        controller?.error(new Error('test finished'));
        await result;
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it('cancels an unread body when the deadline overtakes a room grant', async () => {
    vi.useFakeTimers();
    // Invoke the saved method with each mocked room, rather than the prototype.
    // eslint-disable-next-line @typescript-eslint/unbound-method, vitest/unbound-method -- Explicit receiver is supplied with .call below.
    const hold = ArtifactRoom.prototype.hold;
    const granted = Promise.withResolvers<() => void>();
    const delivered = Promise.withResolvers<() => void>();
    vi.spyOn(ArtifactRoom.prototype, 'hold').mockImplementation(async function delayedGrant(
      this: ArtifactRoom,
      bytes,
      signal,
    ) {
      const release = await hold.call(this, bytes, signal);
      granted.resolve(release);
      return delivered.promise;
    });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
      headers: { 'content-length': String(BYTES.byteLength) },
    });
    const id = await idFor();
    const reading = gateway(() => Promise.resolve(response)).readArtifact(id);
    const result = Promise.allSettled([reading]);
    try {
      const release = await granted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      delivered.resolve(release);
      await vi.advanceTimersByTimeAsync(0);

      await expect(result).resolves.toMatchObject([{ status: 'rejected' }]);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      delivered.resolve(await granted.promise);
      await result;
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('cancels the unread body if its room never comes before the deadline', async () => {
    vi.useFakeTimers();
    const release = takeRoom();
    const served = Promise.withResolvers<undefined>();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
      headers: { 'content-length': String(BYTES.byteLength) },
    });
    const id = await idFor();
    const reading = gateway(() => {
      served.resolve(undefined);
      return Promise.resolve(response);
    }).readArtifact(id);
    const result = Promise.allSettled([reading]);
    try {
      await served.promise;
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toMatchObject([{ status: 'rejected' }]);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await result;
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it.each([true, false])(
    'keeps the stricter old copy ceiling with declared length %s',
    async (declared) => {
      const source = chunks(COPY_LIMIT + CHUNK * 2);
      const copy = new Response(source.body, {
        headers: declared ? { 'content-length': String(LIMIT + 1) } : {},
      });
      const cache = {
        match: () => Promise.resolve(copy),
        delete: () => Promise.resolve(false),
        put: async (_key: RequestInfo, response: Response) => {
          await response.arrayBuffer();
        },
      } as Cache;
      vi.spyOn(caches, 'open').mockResolvedValue(cache);
      const bytes = await gateway(() => {
        return Promise.resolve(
          new Response(BYTES, { headers: { 'content-length': String(BYTES.byteLength) } }),
        );
      }).readArtifact(await idFor());

      expect(bytes).toStrictEqual(BYTES);
      expect(source.sent()).toBeLessThanOrEqual(declared ? 0 : COPY_LIMIT + CHUNK);
      expect(source.cancel).toHaveBeenCalledTimes(1);
    },
  );
});
