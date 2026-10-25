import type { DeploymentBundle, SourceMapRef } from '@stayingupwind/core/bundle';

import type { BlobStore } from './blobs.ts';
import { cloudflareWorkflowParts } from './cloudflare-workflows.ts';
import type { FunctionDependencies } from './dependencies.ts';
import { durableObjectParts } from './durable-objects.ts';
import type { AdapterOptions } from './index.ts';

/** Merge independently packaged native classes without changing the application delivery Function. */
export async function workerClassParts(input: {
  readonly projectDir: string;
  readonly outDir: string;
  readonly blobs: BlobStore;
  readonly options: AdapterOptions;
  readonly split: boolean;
  readonly distDir: string;
}): Promise<{
  bundle: Partial<Pick<DeploymentBundle, 'v' | 'durableObjects' | 'cloudflareWorkflows'>>;
  functions: Partial<Pick<DeploymentBundle['functions'], 'durableObjects' | 'cloudflareWorkflows'>>;
  sourceMaps: SourceMapRef[];
  dependencies: Readonly<Record<string, FunctionDependencies>>;
}> {
  const shared = {
    projectDir: input.projectDir,
    outDir: input.outDir,
    blobs: input.blobs,
    split: input.split,
    distDir: input.distDir,
    sourceMaps: input.options.sourceMaps,
  };
  const objects = await durableObjectParts({
    ...shared,
    declarations: input.options.durableObjects,
  });
  const workflows = await cloudflareWorkflowParts({
    ...shared,
    declarations: input.options.cloudflareWorkflows,
  });
  return {
    bundle: { ...objects.bundle, ...workflows.bundle },
    functions: { ...objects.functions, ...workflows.functions },
    sourceMaps: [...objects.sourceMaps, ...workflows.sourceMaps],
    dependencies: { ...objects.dependencies, ...workflows.dependencies },
  };
}
