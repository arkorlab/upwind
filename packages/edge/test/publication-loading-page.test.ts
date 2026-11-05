import { afterEach, describe, expect, it, vi } from 'vitest';

import { PAGE, pagesPublicationFixture } from './pages-publication-fixture.ts';

vi.mock(import('../src/handlers/passthrough.ts'), async (original) => {
  const module = await original();
  return { ...module, handlePassthrough: vi.fn() };
});

const NOW = 1_800_000_000_000;
const ID = 'a'.repeat(64);
const GRANT = `upwind:publication:v1:${ID}:${String(NOW + 1000)}`;
const SNAPSHOT = `upwind:resource-snapshot:v1:${'b'.repeat(64)}:1`;

async function fixture(tags: readonly string[], independent = false) {
  const test = await pagesPublicationFixture();
  const route = Object.keys(test.manifest.pagesFallbacks ?? {})[0];
  const loading = route === undefined ? undefined : test.manifest.pagesFallbacks?.[route];
  if (route === undefined || loading === undefined) throw new Error('missing loading fixture');

  test.manifest.schemaVersion = 9;

  test.manifest.publication = {
    version: 3,
    valueObservers: true,
    resourceSnapshots: true,
    identities: [ID],
    routes: [route],
    ...(independent && { independentBuild: [route] }),
  };

  loading.headers['x-next-cache-tags'] = tags.join(',');

  test.dispatch.mockResolvedValue(new Response(null));

  vi.spyOn(test.edge.runtime, 'now').mockReturnValue(NOW);
  return test;
}

describe('publication admission for shipped Pages loading shells', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each([
    { name: 'missing grant', tags: [] },
    { name: 'expired grant', tags: [`upwind:publication:v1:${ID}:${String(NOW)}`, SNAPSHOT] },
    { name: 'missing original snapshot', tags: [GRANT] },
    { name: 'foreign identity', tags: [GRANT.replace(ID, 'c'.repeat(64)), SNAPSHOT] },
  ])('delegates a loading shell with $name before reading its bytes', async ({ tags }) => {
    const test = await fixture(tags);

    const response = await test.serve(PAGE);

    await expect(response.text()).resolves.toBe('private fallback');
    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(test.getShell).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();

    await test.drain();
  });

  it('delegates when the original grant expires while reading the selected shell', async () => {
    const test = await fixture([GRANT, SNAPSHOT]);
    const shell = await test.getShell();

    test.getShell.mockClear();

    test.getShell.mockImplementationOnce(() => {
      vi.mocked(test.edge.runtime.now).mockReturnValue(NOW + 1000);
      return Promise.resolve(shell);
    });

    const response = await test.serve(PAGE);

    await expect(response.text()).resolves.toBe('private fallback');
    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(test.getShell).toHaveBeenCalledTimes(1);
    expect(test.dispatch).not.toHaveBeenCalled();

    await test.drain();
  });

  it('keeps the original grant and snapshot on a valid loading shell', async () => {
    const test = await fixture([GRANT, SNAPSHOT]);

    const response = await test.serve(PAGE);

    await expect(response.text()).resolves.toContain('hi fallback');
    expect(response.headers.get('x-next-cache-tags')).toBe([GRANT, SNAPSHOT].join(','));
    expect(response.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
    expect(test.fallback).not.toHaveBeenCalled();

    await test.drain();
  });

  it('delegates when the publication clock moves backward during the shell read', async () => {
    const test = await fixture([GRANT, SNAPSHOT]);
    const shell = await test.getShell();

    test.getShell.mockClear();

    test.getShell.mockImplementationOnce(() => {
      vi.mocked(test.edge.runtime.now).mockReturnValue(NOW - 1);
      return Promise.resolve(shell);
    });

    const response = await test.serve(PAGE);

    await expect(response.text()).resolves.toBe('private fallback');
    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(test.dispatch).not.toHaveBeenCalled();

    await test.drain();
  });

  it('keeps a proven independent loading shell available without a grant', async () => {
    const test = await fixture([], true);

    const response = await test.serve(PAGE);

    await expect(response.text()).resolves.toContain('hi fallback');
    expect(test.fallback).not.toHaveBeenCalled();

    await test.drain();
  });
});
