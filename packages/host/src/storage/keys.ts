/**
 * Where a deployment's objects are kept: the pointer, the manifests and the policies in the edge's
 * KV namespace, and the bundle, its blobs and each manifest's durable copy in the bucket. What
 * writes them and the edge that reads them take the names from here, so the two cannot disagree.
 */

/**
 * The pointer a hostname is served by, under the full hostname: that is what a request arrives
 * with, so the edge resolves a hostname with one read.
 *
 * Spelled as DNS compares a name, which a key is not: in lower case, and without the root's dot
 * that a fully qualified spelling ends in. A pointer written for `Example.com` is then the one a
 * request for `example.com.` finds, whichever of the two spellings either side was handed.
 */
export function kvHostPointerKey(hostname: string): string {
  return `host:${hostname.toLowerCase().replace(/\.$/u, '')}`;
}

/** A manifest, by its id: the digest of its bytes, so what is under a key never changes. */
export function kvManifestKey(manifestId: string): string {
  return `manifest:${manifestId}`;
}

/**
 * Where a manifest's durable copy is kept in the bucket. It is written before the KV entry, and the
 * bucket is consistent where KV is not: it is what a reader falls back to when a data center's KV
 * has not got the entry yet, or cannot be read.
 */
export function r2ManifestKey(manifestId: string): string {
  return `manifests/${manifestId}.json`;
}

/** A delivery policy, by its id. */
export function kvPolicyKey(policyId: string): string {
  return `policy:${policyId}`;
}

/**
 * The one mutable policy key: which policy a site falls back to.
 *
 * Deliberately outside the `policy:` namespace. Sharing it would make `kvPolicyKey('default')` the
 * same key, so storing a policy under that perfectly ordinary id would overwrite the pointer with a
 * policy document, and every site resolving the default would silently drop to the built-in one.
 */
export const KV_DEFAULT_POLICY_KEY = 'default-policy';

/** Where a deployment's bundle is kept, under the project and the deployment it belongs to. */
export function bundleObjectKey(projectId: string, deploymentId: string): string {
  return `deployments/${projectId}/${deploymentId}/bundle.json`;
}

/**
 * Content-addressed blobs a deployment bundle names: shells, static files, Function modules. One
 * key space for every project, because the address is the content and nothing else.
 */
export function blobObjectKey(sha256: string): string {
  return `blobs/${sha256}`;
}
