import { cacheDirectives, removeSharedCacheOverrides } from '../request/cache-control.ts';
import { PLATFORM_HEADER_PREFIX } from '../request/constants.ts';

/** A restrictive response instruction, never an authorization or publication identity proof. */
export const PUBLICATION_POLICY_HEADER = `${PLATFORM_HEADER_PREFIX}publication-policy`;
const NO_TRANSFORM = 'no-transform';
const MAX_POLICY_COMPONENTS = 2;
export interface PublicationPolicy {
  readonly mode: 'no-store' | 'revalidate';
  readonly noTransform: boolean;
}

function directives(headers: Headers): Set<string> {
  return new Set(
    cacheDirectives(headers.get('cache-control') ?? '').map(
      (part) => part.split('=', 1)[0]?.trim().toLowerCase() ?? '',
    ),
  );
}

export function publicationPolicy(headers: Headers): PublicationPolicy | undefined {
  const value = headers.get(PUBLICATION_POLICY_HEADER);
  if (value === null) return undefined;
  const components = value.split(';');
  const [mode, transform] = components;
  if (
    components.length > MAX_POLICY_COMPONENTS ||
    (mode !== 'no-store' && mode !== 'revalidate') ||
    (transform !== undefined && transform !== NO_TRANSFORM)
  )
    return undefined;
  return { mode, noTransform: transform === NO_TRANSFORM };
}

/** The producer seals its restriction before forwarding; public ingress strips this prefix. */
export function markPublicationPolicy(response: Response): Response {
  const names = directives(response.headers);
  const out = new Response(response.body, response);
  const mode = names.has('no-store') ? 'no-store' : 'revalidate';
  out.headers.set(
    PUBLICATION_POLICY_HEADER,
    `${mode}${names.has(NO_TRANSFORM) ? ';no-transform' : ''}`,
  );
  return out;
}

/** Deferred rules and middleware may narrow this policy, never make protected bytes public. */
export function enforcePublicationPolicy(
  headers: Headers,
  policy: PublicationPolicy | undefined,
): void {
  if (policy === undefined) return;
  const names = directives(headers);
  removeSharedCacheOverrides(headers);
  const mode =
    policy.mode === 'no-store' || names.has('no-store')
      ? 'private, no-store'
      : 'private, no-cache, must-revalidate';
  headers.set(
    'cache-control',
    `${mode}${policy.noTransform || names.has(NO_TRANSFORM) ? ', no-transform' : ''}`,
  );
}

/** The native/shared runtime repeats admission after its last target-specific header decision. */
export function withPublicationPolicy(response: Response): Response {
  const policy = publicationPolicy(response.headers);
  if (policy === undefined) return response;
  const out = new Response(response.body, response);
  enforcePublicationPolicy(out.headers, policy);
  return out;
}
