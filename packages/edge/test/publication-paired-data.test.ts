import { admitPublication, type GenerationPackHeader } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DATA, PAGE, pagesPublicationFixture } from './pages-publication-fixture.ts';

vi.mock(import('../src/handlers/passthrough.ts'), async (original) => {
  return {
    ...(await original()),
    handlePassthrough: vi.fn(),
  };
});

function pairedArtifact(header: GenerationPackHeader) {
  const data = header.artifacts.find((artifact) => artifact.role === 'pages-data');
  if (data === undefined) throw new Error('The fixture must include paired data.');
  return data;
}

describe('paired Pages data publication admission', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each([false, true])(
    'checks the grant after the paired artifact read (expires=%s)',
    async (expires) => {
      const test = await pagesPublicationFixture();
      const identity = 'a'.repeat(64);
      let now = test.edge.runtime.now();
      const until = now + 1000;
      Object.assign(test.edge.runtime, { now: () => now });

      test.manifest.publication = {
        version: 1,
        identities: [identity],
        routes: ['/fallback-true/[slug]'],
      };

      const record = await test.member(PAGE, {
        tags: [
          { kind: 'next-explicit', value: `upwind:publication:v1:${identity}:${String(until)}` },
        ],
      });
      const data = pairedArtifact(record.pack.header);

      test.kv.mockImplementation((key) =>
        Promise.resolve(key === record.key ? record.bytes : null),
      );

      const cache = test.edge.runtime.memory.shells;
      const original = cache.get.bind(cache);
      const lookup = vi.spyOn(cache, 'get').mockImplementation((key) => {
        if (expires && key === data.sha256) now = until;
        return original(key);
      });

      const response = await test.serve(DATA);

      expect(lookup).toHaveBeenCalledWith(data.sha256);
      expect(response.status).toBe(expires ? 503 : 200);
      expect(test.dispatch).not.toHaveBeenCalled();

      await test.drain();
    },
  );

  it('keeps a fresh live response when an unavailable paired artifact outlives its old grant', async () => {
    const test = await pagesPublicationFixture();
    const identity = 'a'.repeat(64);
    let now = test.edge.runtime.now();
    const until = now + 1000;
    Object.assign(test.edge.runtime, { now: () => now });

    test.manifest.publication = {
      version: 1,
      identities: [identity],
      routes: ['/fallback-true/[slug]'],
    };

    const record = await test.member(PAGE, {
      tags: [
        { kind: 'next-explicit', value: `upwind:publication:v1:${identity}:${String(until)}` },
      ],
    });
    const data = pairedArtifact(record.pack.header);

    test.edge.runtime.memory.shells.delete(data.sha256);

    test.kv.mockImplementation((key) => Promise.resolve(key === record.key ? record.bytes : null));

    test.get.mockResolvedValue(null);

    test.fallback.mockImplementation(() => {
      now = until;
      return Promise.resolve(
        admitPublication(
          new Response('fresh authorized data'),
          [`upwind:publication:v1:${identity}:${String(until + 60_000)}`],
          now,
        ),
      );
    });

    const response = await test.serve(DATA);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('fresh authorized data');
    expect(test.get).toHaveBeenCalledWith(data.storageRef);
    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(test.dispatch).not.toHaveBeenCalled();

    await test.drain();
  });
});
