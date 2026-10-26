import { UPWIND_AUTH_LOCAL_DEV_ENV } from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isLocalDevelopment } from '../../auth/src/environment.ts';
import { isZeroConfig } from '../../auth/src/zero-config.ts';
import { parseDevRequest } from '../src/args.ts';
import { attestLocalAuth, localAuthEnvironment } from '../src/dev/auth-boundary.ts';

afterEach(() => vi.unstubAllEnvs());

describe('the development identity issuer boundary', () => {
  it('binds locally by default and retains an explicitly requested remote hostname', () => {
    const local = parseDevRequest([]);
    const remote = parseDevRequest(['--hostname', '0.0.0.0']);
    expect(local.answer === undefined ? local.options.hostname : undefined).toBe('127.0.0.1');
    expect(remote.answer === undefined ? remote.options.hostname : undefined).toBe('0.0.0.0');
  });

  it.each(['127.0.0.1', '127.12.3.4', '::1', '::ffff:127.0.0.1'])(
    'attests an actual loopback bind at %s',
    (address) => {
      expect(localAuthEnvironment({ address })).toStrictEqual({ [UPWIND_AUTH_LOCAL_DEV_ENV]: '1' });
    },
  );

  it('restores the previous signal after startup fails or the listener scope closes', () => {
    vi.stubEnv(UPWIND_AUTH_LOCAL_DEV_ENV, undefined);
    expect(() => {
      using boundary = attestLocalAuth({ address: '127.0.0.1' });
      expect(process.env[UPWIND_AUTH_LOCAL_DEV_ENV]).toBe('1');
      // Exercise explicit shutdown as well as automatic disposal on failure.
      boundary[Symbol.dispose]();
      expect(process.env[UPWIND_AUTH_LOCAL_DEV_ENV]).toBeUndefined();
      throw new Error('failed startup');
    }).toThrow('failed startup');
    expect(process.env[UPWIND_AUTH_LOCAL_DEV_ENV]).toBeUndefined();
  });

  it.each(['0.0.0.0', '::', '192.168.1.1', 'localhost', undefined])(
    'does not attest a bind at %s',
    (address) => {
      expect(localAuthEnvironment({ address })).toStrictEqual({ [UPWIND_AUTH_LOCAL_DEV_ENV]: '0' });
    },
  );

  it('fails closed outside the attested development listener and keeps real authentication configured', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(UPWIND_AUTH_LOCAL_DEV_ENV, undefined);
    vi.stubEnv('AUTH_SECRET', undefined);
    vi.stubEnv('BETTER_AUTH_SECRET', undefined);
    expect(isLocalDevelopment()).toBe(false);
    expect(isZeroConfig({})).toBe(false);
    vi.stubEnv(UPWIND_AUTH_LOCAL_DEV_ENV, '1');
    expect(isZeroConfig({})).toBe(true);
    expect(isZeroConfig({ secret: 'configured-real-auth-secret' })).toBe(false);
    vi.stubEnv(UPWIND_AUTH_LOCAL_DEV_ENV, '0');
    expect(isZeroConfig({})).toBe(false);
    vi.stubEnv(UPWIND_AUTH_LOCAL_DEV_ENV, '1');
    vi.stubEnv('NODE_ENV', 'production');
    expect(isLocalDevelopment()).toBe(false);
    expect(isZeroConfig({})).toBe(false);
  });
});
