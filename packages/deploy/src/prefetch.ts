import { bundleBlobs, type DeploymentBundle } from '@stayingupwind/core/bundle';
import { PREFETCH_SERVICE_BINDING } from '@stayingupwind/host/bindings';
import { PREFETCH_DEPLOYMENT_ENTRYPOINT } from '@stayingupwind/host/prefetch-audit';

import type { ServiceBinding } from './bindings.ts';

/** Deployment-time capability metadata only; never imported by the visitor or Function runtime. */
export {
  prefetchAuditIdentity,
  prefetchAuditKey,
  type PrefetchAuditIdentity,
  type PrefetchAuditWitness,
  PREFETCH_DEPLOYMENT_ENTRYPOINT,
} from '@stayingupwind/host/prefetch-audit';
export type PrefetchBlobs = Readonly<Record<string, true>>;

/** A host supplies the bundle it accepted, after verifying the declared blob uploads. */
export function prefetchBlobsOf(bundle: DeploymentBundle): PrefetchBlobs {
  const allowed: Record<string, true> = {};
  for (const sha256 of bundleBlobs(bundle).keys()) allowed[sha256] = true;
  return allowed;
}

/** Exact digests, carried by a configured binding instead of a request's claims. */
export function prefetchBinding(service: string, allowed: PrefetchBlobs): ServiceBinding {
  return {
    name: PREFETCH_SERVICE_BINDING,
    service,
    entrypoint: PREFETCH_DEPLOYMENT_ENTRYPOINT,
    props: { allowedSha256: allowed },
  };
}
