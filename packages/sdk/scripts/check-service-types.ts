import type { Fetcher } from '@cloudflare/workers-types';

import { service } from '../src/service.ts';

/** Compiled with the public SDK types; evaluating this function performs no service call. */
export function publicServiceTypes(): Fetcher | undefined {
  const api: Fetcher | undefined = service('API');
  return api;
}
