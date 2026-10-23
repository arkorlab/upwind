import {
  DeployRefusalError,
  type DeployTarget,
  publishDeployment,
  type StagedDeployment,
} from '@stayingupwind/deploy/deploy';
import {
  builtinDeliveryPolicy,
  DEFAULT_DELIVERY_POLICY,
  type DeliveryPolicy,
  deliveryPolicySchema,
} from '@stayingupwind/host/delivery';

import type { DeploySettings } from './config.ts';
import { MAX_VARIABLE_BYTES } from './env.ts';

/**
 * A staged deployment published (`publishDeployment`): its manifest and shells where the edge reads
 * them, and the pointer that sends the site's requests there — which becomes the edge's `POINTER`
 * binding, fixed in the edge's version for this deployment.
 *
 * The pointer carries the policy it is delivered under (`selectedPolicy`), so the edge reads none:
 * `builtin` where the policy is the built-in one of its id, as every deployment's is here, and the
 * policy itself otherwise. Nothing is read before a visitor's first byte that a version of the edge
 * could have been given.
 */

/** How long a publication is tried again while what it wrote does not read back yet. */
const PUBLISH_WAIT_MS = 90_000;
const PUBLISH_POLL_MS = 3000;

export interface PublishInput {
  readonly target: DeployTarget;
  readonly staged: StagedDeployment;
  readonly settings: Pick<DeploySettings, 'cspNonce'>;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What the pointer selects: `builtin`, for a policy that is the built-in one of its id. */
export function selectedPolicyOf(policy: DeliveryPolicy): 'builtin' | DeliveryPolicy {
  const parsed = deliveryPolicySchema.parse(policy);
  const builtin = builtinDeliveryPolicy(parsed.id);
  const same =
    builtin !== undefined &&
    JSON.stringify(deliveryPolicySchema.parse(builtin)) === JSON.stringify(parsed);
  return same ? 'builtin' : parsed;
}

/** Publish the staged deployment, and the pointer to it as the edge's binding holds it. */
export async function publishPointer(input: PublishInput): Promise<string> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? waitFor;
  const nonce = input.settings.cspNonce;
  const until = now() + PUBLISH_WAIT_MS;
  for (;;) {
    try {
      const pointer = await publishDeployment(input.target, input.staged, {
        policy: DEFAULT_DELIVERY_POLICY,
        ...(nonce !== undefined && {
          cspNonce: true,
          cspNonceMode: nonce.mode,
          cspStrictDynamic: nonce.strictDynamic,
        }),
        now,
      });
      const json = JSON.stringify({
        ...pointer,
        selectedPolicy: selectedPolicyOf(DEFAULT_DELIVERY_POLICY),
      });
      const bytes = new TextEncoder().encode(json).byteLength;
      if (bytes > MAX_VARIABLE_BYTES) {
        throw new DeployRefusalError(
          `the deployment's pointer is ${bytes} bytes, over the ${MAX_VARIABLE_BYTES} a Worker's variable holds`,
          { code: 'bundle_invalid' },
        );
      }
      return json;
    } catch (error) {
      // A refusal is the deployment's and stands; anything else is the store's, and passes.
      if (error instanceof DeployRefusalError || now() >= until) {
        throw error;
      }
      await sleep(PUBLISH_POLL_MS);
    }
  }
}
