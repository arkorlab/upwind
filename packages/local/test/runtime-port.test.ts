import { describe, expect, it } from 'vitest';

import { requestedRuntimePort, runtimePortBinding } from '../src/runtime-port.ts';

describe('the local Function listening port', () => {
  it('uses the explicit port before PORT and otherwise requests a free port', () => {
    expect(requestedRuntimePort(undefined, undefined)).toBeUndefined();
    expect(requestedRuntimePort(undefined, { APP_VALUE: 'unchanged' })).toBeUndefined();
    expect(requestedRuntimePort(undefined, { PORT: '8080' })).toBe(8080);
    expect(requestedRuntimePort(9090, { PORT: '8080' })).toBe(9090);
    expect(requestedRuntimePort(9090, { PORT: 'not-a-port' })).toBe(9090);
  });

  it('replaces an ephemeral request with the actual allocated port, without changing the caller', () => {
    const environment = { PORT: '0', VERCEL_URL: 'explicit.example', APP_VALUE: 'retained' };

    expect(requestedRuntimePort(undefined, environment)).toBe(0);
    expect(requestedRuntimePort(0, { PORT: '8080' })).toBe(0);
    expect(runtimePortBinding({ port: 41_789 })).toStrictEqual({
      name: 'PORT',
      value: '41789',
      secret: false,
    });
    expect(environment).toStrictEqual({
      PORT: '0',
      VERCEL_URL: 'explicit.example',
      APP_VALUE: 'retained',
    });
  });

  it.each([80, 443, 65_535])(
    'publishes the concrete numeric port %s without URL normalization',
    (port) => {
      expect(runtimePortBinding({ port }).value).toBe(String(port));
    },
  );

  it.each(['', ' ', '-1', '+80', '1.5', '1e3', '65536', 'NaN', 'Infinity'])(
    'refuses an invalid PORT request %j',
    (PORT) => {
      expect(() => requestedRuntimePort(undefined, { PORT })).toThrow(/whole listening port/u);
    },
  );

  it.each([-1, 0.5, 65_536, NaN, Infinity])('refuses an invalid explicit port %s', (port) => {
    expect(() => requestedRuntimePort(port, { PORT: '8080' })).toThrow(/whole listening port/u);
  });

  it.each([0, -1, 0.5, 65_536])('never publishes an unallocated socket port %s', (port) => {
    expect(() => runtimePortBinding({ port })).toThrow(/allocated listening port/u);
  });
});
