import { sha256HexOfText } from '@stayingupwind/core/artifact';
import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import type { DeploymentFingerprint } from '@stayingupwind/core/deployment';

/**
 * A deployment's fingerprint, in the shape a fronted origin's has, so that the edge's deployment
 * checks — the `?dpl` query and the skew-protection cookie among them — work unchanged for a hosted
 * application: its id, its build, the digest of its bundle as stored, and when it was observed.
 */
export async function deploymentFingerprintOf(
  bundle: DeploymentBundle,
  json: string,
  observedAt: string,
): Promise<DeploymentFingerprint> {
  return {
    dplId: bundle.deploymentId,
    buildId: bundle.buildId,
    assetSetHash: await sha256HexOfText(json),
    observedAt,
  };
}
