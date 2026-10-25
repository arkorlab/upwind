import { type DeploymentBundle, deploymentBundleSchema } from '@stayingupwind/core/bundle';
import { DeployRefusalError } from '@stayingupwind/deploy/deploy';
import { bundleObjectKey } from '@stayingupwind/host/storage';

import type { RemoteTarget } from './target.ts';

/** A deployment's bundle as the bucket keeps it, and the bytes it was kept as. */
export interface KeptBundle {
  readonly bundle: DeploymentBundle;
  readonly json: string;
}

/**
 * A deployment's bundle as the bucket keeps it; nothing where it keeps none. One this version
 * cannot read — not JSON, or no bundle by the schema — is refused (`bundle_invalid`): like any
 * refusal of publishing a deployment again, the deployment's own.
 */
export async function bundleIn(
  target: RemoteTarget,
  project: string,
  deploymentId: string,
): Promise<KeptBundle | undefined> {
  const bytes = await target.bucket.get(bundleObjectKey(project, deploymentId));
  if (bytes === undefined) {
    return undefined;
  }
  const json = new TextDecoder().decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new DeployRefusalError('its kept bundle is not JSON', {
      code: 'bundle_invalid',
      cause: error,
    });
  }
  const parsed = deploymentBundleSchema.safeParse(value);
  if (!parsed.success) {
    throw new DeployRefusalError('its kept bundle is not a deployment bundle this version reads', {
      code: 'bundle_invalid',
      cause: parsed.error,
    });
  }
  return { bundle: parsed.data, json };
}

/** A kept build refused where the command cannot bind its route gates. */
export function refuseUnboundGates(bundle: DeploymentBundle): void {
  if (bundle.gates !== undefined) {
    throw new DeployRefusalError(
      'the kept build declares route gates, which `upwind rollback` does not bind yet; deploy it with a host that binds those gates',
      { code: 'bundle_invalid' },
    );
  }
}
