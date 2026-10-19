import type { RouteEntry } from '@stayingupwind/core/manifest';

/** Optional hints that would make a joined Link field invalid, even beside an existing value. */
const UNSAFE_PRELOAD = /[\0\r\n]/u;

/** Cold decode only: omit unsafe hints, retaining every safe value exactly as stored. */
export function retainSafePreloads(route: RouteEntry): void {
  const { preloads } = route;
  if (preloads === undefined || !preloads.some((value) => UNSAFE_PRELOAD.test(value))) {
    return;
  }
  const safe = preloads.filter((value) => !UNSAFE_PRELOAD.test(value));
  if (safe.length === 0) {
    delete route.preloads;
  } else {
    route.preloads = safe;
  }
}
