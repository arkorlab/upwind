import {
  edgeServableStaticPages,
  staticFallbackPagesOf,
  type ServingBundle,
} from '@stayingupwind/core/bundle';
import { STATIC_PAGES_FALLBACK_PRIVACY } from '@stayingupwind/core/cache';

const CAPABILITY = { staticPagesPrivacy: STATIC_PAGES_FALLBACK_PRIVACY } as const;

/** Only Functions that can regenerate an admitted Pages output need the runtime capability. */
export function staticPagesRuntimeFields(bundle: ServingBundle): Partial<typeof CAPABILITY> {
  const candidate = { ...bundle, ...CAPABILITY };
  return edgeServableStaticPages(candidate).some((page) => page.initialRevalidate !== false) ||
    staticFallbackPagesOf(candidate).length > 0
    ? CAPABILITY
    : {};
}
