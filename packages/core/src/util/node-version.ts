/** Exact Node loaders reviewed for the fixed Next.js initialization profiles. */
export type GuardedNodeVersion = '24.22.1' | '24.22.3' | '26.13.0' | '26.13.1';

export function isGuardedNodeVersion(value: unknown): value is GuardedNodeVersion {
  return value === '24.22.1' || value === '24.22.3' || value === '26.13.0' || value === '26.13.1';
}
