import type { DeploymentBundle } from './schema.ts';

/**
 * The fields of a deployment's runtime manifest that say which deployment and build it is, and its
 * configuration: the part every Function carries, and all a Function that runs the middleware
 * alone does.
 *
 * One list, for the side that writes that Function's manifest and the side that reads it: a field
 * the reader comes to need is a field the writer then keeps, rather than one it drops unseen.
 */
const MANIFEST_HEAD_KEYS = [
  'v',
  'deploymentId',
  'nextVersion',
  'buildId',
  'config',
] as const satisfies readonly (keyof DeploymentBundle)[];

/** A runtime manifest's head (`MANIFEST_HEAD_KEYS`). */
export type ManifestHead = Pick<DeploymentBundle, (typeof MANIFEST_HEAD_KEYS)[number]>;

/** The head of a runtime manifest, and none of the rest. */
export function manifestHead<T extends Readonly<Record<keyof ManifestHead, unknown>>>(
  manifest: T,
): Pick<T, keyof ManifestHead> {
  return Object.fromEntries(MANIFEST_HEAD_KEYS.map((key) => [key, manifest[key]])) as Pick<
    T,
    keyof ManifestHead
  >;
}
