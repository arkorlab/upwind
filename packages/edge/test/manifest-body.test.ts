import { MAX_MANIFEST_BYTES, serializeManifest } from '@stayingupwind/core/manifest';
import { r2ManifestKey } from '@stayingupwind/host/storage';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeBindings } from '../src/bindings.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { getManifest } from '../src/preview/manifest.ts';
import { standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const READ_MS = 2000;

async function fixture() {
  const site = await seedSite({ document: pprDocument() });
  const bytes = new TextEncoder().encode(serializeManifest(site.manifest));
  const pending = Promise.withResolvers<R2ObjectBody | null>();
  const get = vi.fn(() => pending.promise);
  const bindings: EdgeBindings = {
    ...env,
    EDGE_STATE: { get: () => Promise.resolve(null) } as unknown as KVNamespace,
    ARTIFACTS: { get } as unknown as R2Bucket,
  };
  const runtime = standaloneRuntime(env, { memory: createEdgeMemory(() => Date.now()) });
  return {
    site,
    bytes,
    pending,
    get,
    runtime,
    read: () =>
      getManifest(bindings, runtime, site.manifestId, { live: false, holdAbsence: false }),
  };
}

/** Model the same body exposed by R2's native arrayBuffer method before the fix. */
function objectWith(body: ReadableStream<Uint8Array> | null, size: number) {
  const response = new Response(body);
  const arrayBuffer = vi.fn(() => response.arrayBuffer());
  return {
    object: { size, body: response.body, arrayBuffer } as unknown as R2ObjectBody,
    arrayBuffer,
  };
}

async function settled(pending: Promise<unknown>): Promise<'fulfilled' | 'rejected'> {
  try {
    await pending;
    return 'fulfilled';
  } catch {
    return 'rejected';
  }
}

function finishLate(
  input: ReadableStreamDefaultController<Uint8Array>,
  outcome: 'close' | 'error',
): void {
  try {
    if (outcome === 'close') input.close();
    else input.error(new Error('late manifest body failure'));
  } catch {
    // Cancellation already closed this source; neither late outcome can supply more bytes.
  }
}

describe('the durable manifest owns its body until its backend deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['close', 'error'] as const)(
    'cancels a partial body whose source never acknowledges, consuming late %s',
    async (outcome) => {
      const subject = await fixture();
      const input = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
      const cancelled = vi.fn(() => Promise.withResolvers<never>().promise);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(subject.bytes.subarray(0, 1));
          input.resolve(controller);
        },
        cancel: cancelled,
      });
      const original = objectWith(stream, subject.bytes.byteLength);
      const controller = await input.promise;
      subject.pending.resolve(original.object);
      vi.spyOn(console, 'warn').mockReturnValue();
      vi.useFakeTimers();
      const reading = subject.read();
      try {
        await vi.advanceTimersByTimeAsync(READ_MS + 1);

        expect((await reading).kind).toBe('missing');
        expect(cancelled).toHaveBeenCalledExactlyOnceWith(expect.any(String));
        expect(original.arrayBuffer).not.toHaveBeenCalled();

        finishLate(controller, outcome);
        await vi.advanceTimersByTimeAsync(0);

        expect(subject.runtime.memory.manifests.get(subject.site.manifestId)).toBeUndefined();
        expect(subject.runtime.memory.absentManifests.get(subject.site.manifestId)).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);

        subject.get.mockResolvedValue(
          objectWith(new Response(subject.bytes).body, subject.bytes.byteLength).object,
        );

        expect((await subject.read()).kind).toBe('found');
        expect(subject.get).toHaveBeenCalledTimes(2);
      } finally {
        finishLate(controller, 'error');
        await reading;
      }
    },
  );

  it('cancels the owned native BYOB read after a partial native body', async () => {
    const subject = await fixture();
    const source = new IdentityTransformStream();
    const writer = source.writable.getWriter();
    const writing = settled(writer.write(subject.bytes.subarray(0, 1)));
    const closed = settled(writer.closed);
    const original = objectWith(source.readable, subject.bytes.byteLength);
    subject.pending.resolve(original.object);
    vi.spyOn(console, 'warn').mockReturnValue();
    vi.useFakeTimers();
    const reading = subject.read();
    try {
      // Consume the native prefix before advancing its owner's deadline.
      await expect(writing).resolves.toBe('fulfilled');

      await vi.advanceTimersByTimeAsync(READ_MS + 1);

      expect((await reading).kind).toBe('missing');
      // IdentityTransformStream exposes a readable cancel to its writer on the next write;
      // writer.closed alone need not settle proactively in workerd's native implementation.
      const nextWriting = settled(writer.write(subject.bytes.subarray(0, 1)));

      await expect(nextWriting).resolves.toBe('rejected');
      await expect(closed).resolves.toBe('rejected');
      expect(original.arrayBuffer).not.toHaveBeenCalled();
      expect(subject.runtime.memory.manifests.get(subject.site.manifestId)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await settled(writer.abort());
      await writing;
      await closed;
      await reading;
    }
  });

  it.each([-1, 1])('does not adopt bytes whose R2 size differs by %s', async (difference) => {
    const subject = await fixture();
    const original = objectWith(
      new Response(subject.bytes).body,
      subject.bytes.byteLength + difference,
    );
    subject.pending.resolve(original.object);
    vi.spyOn(console, 'warn').mockReturnValue();
    vi.useFakeTimers();

    const result = await subject.read();

    expect(result.kind).toBe('missing');
    expect(original.arrayBuffer).not.toHaveBeenCalled();
    expect(subject.runtime.memory.manifests.get(subject.site.manifestId)).toBeUndefined();
    expect(subject.runtime.memory.absentManifests.get(subject.site.manifestId)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hashes and parses only the exact visible bytes of a timely native R2 body', async () => {
    const subject = await fixture();
    const key = r2ManifestKey(subject.site.manifestId);
    // seedSite leaves its manifest in KV; this control explicitly exercises R2's native body.
    await env.ARTIFACTS.put(key, subject.bytes);
    const object = await env.ARTIFACTS.get(key);

    expect(object).not.toBeNull();

    subject.pending.resolve(object);
    vi.useFakeTimers();

    const result = await subject.read();

    expect(result.kind).toBe('found');
    expect(subject.runtime.memory.manifests.get(subject.site.manifestId)).toBeDefined();
    expect(subject.get).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the existing size refusal before any body read starts', async () => {
    const subject = await fixture();
    const pull = vi.fn();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel: cancelled }, { highWaterMark: 0 });
    const original = objectWith(body, MAX_MANIFEST_BYTES + 1);
    subject.pending.resolve(original.object);
    vi.spyOn(console, 'warn').mockReturnValue();
    vi.useFakeTimers();

    const result = await subject.read();

    expect(result.kind).toBe('missing');
    expect(pull).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(original.arrayBuffer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
