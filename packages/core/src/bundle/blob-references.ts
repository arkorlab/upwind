import type { BlobRef } from './blob.ts';
import { isNodeContainerFunction } from './function-contract.ts';
import type { DeploymentBundle } from './schema.ts';

/** The complete reference walk shared by validation and collection. */
export function forEachBlob(bundle: DeploymentBundle, visit: (ref: BlobRef) => void): void {
  const add = (ref: BlobRef | undefined): void => {
    if (ref !== undefined) visit(ref);
  };
  for (const prerender of bundle.prerenders) {
    add(prerender.body);
    add(prerender.postponed);
  }
  for (const file of bundle.staticFiles) {
    add(file.blob);
  }
  if (bundle.sourceMaps !== undefined) {
    for (const map of bundle.sourceMaps) {
      add(map.blob);
      add(map.sources);
    }
  }
  const functions = [
    bundle.functions.app,
    bundle.functions.middleware,
    ...Object.values(bundle.functions.split ?? {}),
    bundle.functions.workflow,
    ...Object.values(bundle.functions.durableObjects ?? {}),
    ...Object.values(bundle.functions.cloudflareWorkflows ?? {}),
  ];
  for (const spec of functions) {
    if (spec === undefined) {
      continue;
    }
    if (isNodeContainerFunction(spec)) {
      add(spec.artifact);
      continue;
    }
    for (const module of spec.modules) {
      add(module.blob);
    }
  }
}

/** Every blob a validated bundle references, deduplicated by content. */
export function bundleBlobs(bundle: DeploymentBundle): Map<string, BlobRef> {
  const blobs = new Map<string, BlobRef>();
  forEachBlob(bundle, (ref) => blobs.set(ref.sha256, ref));
  return blobs;
}
