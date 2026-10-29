/** Exact Node loaders reviewed for the fixed Next.js initialization profiles. */
export type GuardedNodeVersion = '24.22.1' | '26.13.0';

export function isGuardedNodeVersion(value: unknown): value is GuardedNodeVersion {
  return value === '24.22.1' || value === '26.13.0';
}
