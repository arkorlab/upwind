import type { NextAdapter } from 'next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { environmentOptions } from '../src/environment-options.ts';
import { createAdapter } from '../src/index.ts';
import { runtimeTargetOf } from '../src/native/target.ts';

type ModifyConfig = NonNullable<NextAdapter['modifyConfig']>;
type Config = Parameters<ModifyConfig>[0];
type Context = Parameters<ModifyConfig>[1];
const BUILD = { phase: 'phase-production-build', projectDir: '/project' } as Context;
const DEV = { phase: 'phase-development-server', projectDir: '/project' } as Context;

describe('native target selection', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps Cloudflare as the default and accepts an explicit Node target', () => {
    vi.stubEnv('UPWIND_BUILD_TARGET', '');

    expect(runtimeTargetOf()).toBe('cloudflare');
    expect(runtimeTargetOf('node')).toBe('node');
    expect(createAdapter({ target: 'node' }).name).toBe('upwind');
  });

  it('honors the CLI selection even when next.config creates its adapter directly', () => {
    vi.stubEnv('UPWIND_BUILD_TARGET', 'node');

    expect(runtimeTargetOf()).toBe('node');
    expect(runtimeTargetOf('node')).toBe('node');
    expect(() => createAdapter({ target: 'cloudflare' })).toThrow('conflicts');
  });

  it('refuses an unknown target before building anything', () => {
    vi.stubEnv('UPWIND_BUILD_TARGET', 'workers');

    expect(() => createAdapter()).toThrow('must be cloudflare or node');
  });

  it('refuses a custom cache host rather than replacing the native persistent cache silently', () => {
    vi.stubEnv('UPWIND_BUILD_TARGET', '');

    expect(() => createAdapter({ target: 'node', cacheHostModule: '/host/cache.ts' })).toThrow(
      'remove cacheHostModule',
    );
    expect(createAdapter({ target: 'cloudflare', cacheHostModule: '/host/cache.ts' }).name).toBe(
      'upwind',
    );
  });

  it('publishes a config-selected native target before prerender workers fork without restricting their count', async () => {
    vi.stubEnv('UPWIND_BUILD_TARGET', '');
    vi.stubEnv('UPWIND_LOCAL_RESOURCES', '1');
    createAdapter();
    const adapter = createAdapter({ target: 'node' });
    const config = { experimental: {} } as Config;

    expect(process.env['UPWIND_BUILD_TARGET']).toBe('');

    await adapter.modifyConfig?.(config, BUILD);

    expect(process.env['UPWIND_BUILD_TARGET']).toBe('node');
    expect(config.experimental).not.toHaveProperty('cpus');
  });

  it('does not publish a native build target during development', async () => {
    vi.stubEnv('UPWIND_BUILD_TARGET', '');
    const adapter = createAdapter({ target: 'node' });

    await adapter.modifyConfig?.({ experimental: {} } as Config, DEV);

    expect(process.env['UPWIND_BUILD_TARGET']).toBe('');
  });

  it('preserves an explicit environment conflict detected after adapter construction', async () => {
    vi.stubEnv('UPWIND_BUILD_TARGET', '');
    const adapter = createAdapter({ target: 'node' });
    vi.stubEnv('UPWIND_BUILD_TARGET', 'cloudflare');

    await expect(adapter.modifyConfig?.({ experimental: {} } as Config, BUILD)).rejects.toThrow(
      'conflicts',
    );
    expect(process.env['UPWIND_BUILD_TARGET']).toBe('cloudflare');
  });

  it('removes only the CLI-generated cache host before a native renderer imports the default adapter', async () => {
    vi.stubEnv('UPWIND_BUILD_TARGET', '');
    vi.stubEnv('UPWIND_CACHE_HOST_MODULE', '/generated/cache-host.mjs');
    vi.stubEnv('UPWIND_BUILD_CACHE_HOST_MODULE', '/generated/cache-host.mjs');
    const adapter = createAdapter({ target: 'node' });

    await adapter.modifyConfig?.({ experimental: {} } as Config, BUILD);

    expect(process.env['UPWIND_CACHE_HOST_MODULE']).toBeUndefined();
    expect(process.env['UPWIND_BUILD_CACHE_HOST_MODULE']).toBeUndefined();
    expect(() => createAdapter(environmentOptions())).not.toThrow();
  });

  it('keeps an explicit user cache host even when a CLI-generated marker was inherited', async () => {
    vi.stubEnv('UPWIND_BUILD_TARGET', '');
    vi.stubEnv('UPWIND_CACHE_HOST_MODULE', '/user/cache-host.mjs');
    vi.stubEnv('UPWIND_BUILD_CACHE_HOST_MODULE', '/generated/cache-host.mjs');
    const adapter = createAdapter({ target: 'node' });

    await adapter.modifyConfig?.({ experimental: {} } as Config, BUILD);

    expect(process.env['UPWIND_CACHE_HOST_MODULE']).toBe('/user/cache-host.mjs');
    expect(process.env['UPWIND_BUILD_CACHE_HOST_MODULE']).toBeUndefined();
    expect(() => createAdapter(environmentOptions())).toThrow('remove cacheHostModule');
  });
});
