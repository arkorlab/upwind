import {
  builtinDeliveryPolicy,
  type DeliveryPolicy,
  deliveryPolicySchema,
  type EdgePointer,
} from '@stayingupwind/host/delivery';

/** Parsed once per immutable pointer object; never installed in the shared policy-id cache. */
const selectedPolicies = new WeakMap<EdgePointer, DeliveryPolicy | null>();

/** The exact policy copied by the publisher, or no usable hint. */
export function selectedPolicy(pointer: EdgePointer): DeliveryPolicy | undefined {
  if (pointer.selectedPolicy === undefined) {
    return undefined;
  }
  if (pointer.selectedPolicy === 'builtin') {
    return builtinDeliveryPolicy(pointer.policyId);
  }
  const cached = selectedPolicies.get(pointer);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  const parsed = deliveryPolicySchema.safeParse(pointer.selectedPolicy);
  const policy = parsed.success && parsed.data.id === pointer.policyId ? parsed.data : null;
  selectedPolicies.set(pointer, policy);
  return policy ?? undefined;
}
