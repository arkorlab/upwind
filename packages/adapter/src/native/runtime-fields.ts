import { STATIC_PAGES_FALLBACK_PRIVACY } from '@stayingupwind/core/cache';

/**
 * What a publication tells the edge of the build, said to the native server's runtime in its own
 * bundle (`runtime.json`): the server is its own host, answers by the edge's rules
 * (`runtime/src/native/delivery.ts`), and seeds its own cache with the privacy those rules read
 * (`seedEntriesOf`).
 */
export const NATIVE_RUNTIME_FIELDS = {
  routeBodyPrivacy: 2,
  staticPagesPrivacy: STATIC_PAGES_FALLBACK_PRIVACY,
} as const;
