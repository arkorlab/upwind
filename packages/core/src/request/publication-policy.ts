import { cacheDirectives, removeSharedCacheOverrides } from './cache-control.ts';
import { SHARED_CACHE_CONTROL_HEADERS } from './constants.ts';

/** A response restriction, never an authorization or publication identity proof. */
export interface PublicationPolicy {
  readonly mode: 'no-store' | 'revalidate';
  readonly noTransform: boolean;
}

function directives(headers: Headers, name = 'cache-control'): Set<string> {
  return new Set(
    cacheDirectives(headers.get(name) ?? '').map(
      (part) => part.split('=', 1)[0]?.trim().toLowerCase() ?? '',
    ),
  );
}

/** Preserve byte-transformation restrictions from targeted cache fields before removing them. */
export function publicationPolicyFor(headers: Headers): PublicationPolicy {
  const names = directives(headers);
  return {
    mode: names.has('no-store') ? 'no-store' : 'revalidate',
    noTransform:
      names.has('no-transform') ||
      SHARED_CACHE_CONTROL_HEADERS.some((name) => directives(headers, name).has('no-transform')),
  };
}

/** Later header decisions can narrow the producer's restriction, never widen it. */
export function restrictPublicationCache(headers: Headers, policy?: PublicationPolicy): void {
  const current = publicationPolicyFor(headers);
  const sealed = policy ?? current;
  removeSharedCacheOverrides(headers);
  const mode =
    sealed.mode === 'no-store' || current.mode === 'no-store'
      ? 'private, no-store'
      : 'private, no-cache, must-revalidate';
  headers.set(
    'cache-control',
    `${mode}${sealed.noTransform || current.noTransform ? ', no-transform' : ''}`,
  );
}
