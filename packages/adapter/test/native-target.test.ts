import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAdapter } from '../src/index.ts';
import { runtimeTargetOf } from '../src/native/target.ts';

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
});
