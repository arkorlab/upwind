import { BlockList, isIP } from 'node:net';

import { UPWIND_AUTH_LOCAL_DEV_ENV } from '@stayingupwind/core/paas';

import { setEnv } from './env.ts';
import type { Bound } from './listen.ts';

const LOOPBACK = new BlockList();
const IPV4_LOOPBACK_PREFIX = 8;
const IPV4_FAMILY = 4;
LOOPBACK.addSubnet('127.0.0.0', IPV4_LOOPBACK_PREFIX, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** Only the address the listening socket reports can enable the development identity issuer. */
export function localAuthEnvironment(bound: Pick<Bound, 'address'>): Record<string, string> {
  const address = bound.address;
  const family = address === undefined ? 0 : isIP(address);
  const local =
    address !== undefined &&
    family !== 0 &&
    LOOPBACK.check(address, family === IPV4_FAMILY ? 'ipv4' : 'ipv6');
  // A remote bind must overwrite an inherited attestation from another dev process.
  return { [UPWIND_AUTH_LOCAL_DEV_ENV]: local ? '1' : '0' };
}

/** Restore the previous signal on every return or startup failure, and when shutdown closes the app. */
export function attestLocalAuth(bound: Pick<Bound, 'address'>): Disposable {
  return {
    [Symbol.dispose]: setEnv(
      UPWIND_AUTH_LOCAL_DEV_ENV,
      localAuthEnvironment(bound)[UPWIND_AUTH_LOCAL_DEV_ENV],
    ),
  };
}
