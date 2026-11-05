import { PLATFORM_HEADER_PREFIX } from '../request/constants.ts';
import {
  publicationPolicyFor,
  restrictPublicationCache,
  type PublicationPolicy,
} from '../request/publication-policy.ts';

export type { PublicationPolicy } from '../request/publication-policy.ts';

/** A restrictive response instruction, never an authorization or publication identity proof. */
export const PUBLICATION_POLICY_HEADER = `${PLATFORM_HEADER_PREFIX}publication-policy`;
const NO_TRANSFORM = 'no-transform';
const MAX_POLICY_COMPONENTS = 2;

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
    return { mode: 'no-store', noTransform: true };
  return { mode, noTransform: transform === NO_TRANSFORM };
}

/** The producer seals its restriction before forwarding; public ingress strips this prefix. */
export function markPublicationPolicy(response: Response): Response {
  const policy = publicationPolicyFor(response.headers);
  const out = new Response(response.body, response);
  out.headers.set(
    PUBLICATION_POLICY_HEADER,
    `${policy.mode}${policy.noTransform ? ';no-transform' : ''}`,
  );
  return out;
}

/** Deferred rules and middleware may narrow this policy, never make protected bytes public. */
export function enforcePublicationPolicy(
  headers: Headers,
  policy: PublicationPolicy | undefined,
): void {
  if (policy === undefined) return;
  restrictPublicationCache(headers, policy);
}

/** The native/shared runtime repeats admission after its last target-specific header decision. */
export function withPublicationPolicy(response: Response): Response {
  const policy = publicationPolicy(response.headers);
  if (policy === undefined) return response;
  const out = new Response(response.body, response);
  enforcePublicationPolicy(out.headers, policy);
  return out;
}
