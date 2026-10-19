/** Operator-only migration evidence, separate from every bundle/blob key. */
export const PREFETCH_AUDIT_PREFIX = 'prefetch-binding-audits/v1/';
export const PREFETCH_DEPLOYMENT_ENTRYPOINT = 'PrefetchForDeployment';

export interface PrefetchAuditIdentity {
  readonly nonce: string;
  readonly deploymentId: string;
  readonly scriptName: string;
}

export interface PrefetchAuditWitness extends PrefetchAuditIdentity {
  readonly version: 1;
  readonly service: string;
  readonly entrypoint: string;
  readonly allowedSha256: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Only the operator-generated nonce determines the private evidence object's key. */
export function prefetchAuditKey(nonce: string): string {
  if (!UUID.test(nonce)) throw new TypeError('invalid prefetch audit nonce');
  return `${PREFETCH_AUDIT_PREFIX}${nonce}.json`;
}

export function prefetchAuditIdentity(value: unknown): PrefetchAuditIdentity | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const nonce: unknown = Reflect.get(value, 'nonce');
  const deploymentId: unknown = Reflect.get(value, 'deploymentId');
  const scriptName: unknown = Reflect.get(value, 'scriptName');
  if (
    typeof nonce !== 'string' ||
    typeof deploymentId !== 'string' ||
    typeof scriptName !== 'string' ||
    deploymentId.length === 0 ||
    scriptName.length === 0 ||
    !UUID.test(nonce)
  ) {
    return undefined;
  }
  return { nonce, deploymentId, scriptName };
}
