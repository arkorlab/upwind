import { describe, expect, it } from 'vitest';

import { nativeBridgeOptions } from '../../src/native/options.ts';

describe('native executable response-header budget', () => {
  it('keeps the transport default when the environment has no override', () => {
    expect(nativeBridgeOptions({})).toStrictEqual({});
    expect(nativeBridgeOptions({ UPWIND_NODE_HEADERS_TIMEOUT_MS: '' })).toStrictEqual({});
  });

  it('reads a positive integer override without changing other bridge options', () => {
    expect(nativeBridgeOptions({ UPWIND_NODE_HEADERS_TIMEOUT_MS: '90000' })).toStrictEqual({
      headersTimeoutMs: 90_000,
    });
  });

  it.each(['0', '-1', '1.5', 'Infinity', '2e3', ' 1000 ', '2147483648'])(
    'rejects an invalid native header budget %s',
    (value) => {
      expect(() => nativeBridgeOptions({ UPWIND_NODE_HEADERS_TIMEOUT_MS: value })).toThrow(
        /UPWIND_NODE_HEADERS_TIMEOUT_MS/u,
      );
    },
  );
});
