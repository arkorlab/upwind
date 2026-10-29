import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resources = vi.hoisted(() => {
  return {
    loaded: [] as string[],
    start: vi.fn(),
    install: vi.fn(),
  };
});

vi.mock(import('../src/resources/shared.ts'), () => {
  resources.loaded.push('local');
  return { getOrStartLocalResources: resources.start };
});

vi.mock(import('../src/resources/next-cache-loader.ts'), () => {
  resources.loaded.push('loader');
  return { installNextResourceCacheLoader: resources.install };
});

describe('the build resource preload', () => {
  beforeEach(() => {
    vi.resetModules();
    resources.loaded.length = 0;
    resources.start.mockClear();
    resources.install.mockClear();
    vi.stubEnv('UPWIND_PROJECT_DIR', '/project');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('loads no Cloudflare resource modules for a native prerender worker', async () => {
    vi.stubEnv('__NEXT_PRERENDER_CLIENT_ASSET_SUFFIX', 'fixture');
    vi.stubEnv('UPWIND_BUILD_TARGET', 'node');

    await import('../src/resources/entry.ts');

    expect(resources.loaded).toStrictEqual([]);
    expect(resources.install).not.toHaveBeenCalled();
    expect(resources.start).not.toHaveBeenCalled();
  });

  it('loads no Cloudflare resource modules in the main build process', async () => {
    vi.stubEnv('__NEXT_PRERENDER_CLIENT_ASSET_SUFFIX', undefined);
    vi.stubEnv('UPWIND_BUILD_TARGET', '');

    await import('../src/resources/entry.ts');

    expect(resources.loaded).toStrictEqual([]);
    expect(resources.install).not.toHaveBeenCalled();
    expect(resources.start).not.toHaveBeenCalled();
  });

  it('continues publishing local resources for a Cloudflare prerender worker', async () => {
    vi.stubEnv('__NEXT_PRERENDER_CLIENT_ASSET_SUFFIX', 'fixture');
    vi.stubEnv('UPWIND_BUILD_TARGET', 'cloudflare');

    await import('../src/resources/entry.ts');

    expect(resources.install).toHaveBeenCalledExactlyOnceWith();
    expect(resources.start).toHaveBeenCalledWith('/project', {
      answersSignals: false,
      mode: 'production',
    });
  });
});
