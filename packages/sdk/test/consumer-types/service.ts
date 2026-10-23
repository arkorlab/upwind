import type { Fetcher } from '@cloudflare/workers-types';
import { service as fromRoot } from '@stayingupwind/sdk';
import { service as fromSubpath } from '@stayingupwind/sdk/service';

/** Compile both installed entry points against their emitted declarations without making a call. */
export function publicServiceTypes(): readonly (Fetcher | undefined)[] {
  const root: Fetcher | undefined = fromRoot('API');
  const subpath: Fetcher | undefined = fromSubpath('API');
  return [root, subpath];
}
