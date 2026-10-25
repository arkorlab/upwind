import path from 'node:path';

import {
  type CloudflareWorkflowDeclaration,
  type DeploymentBundle,
  type FunctionSpec,
  type SourceMapRef,
  cloudflareWorkflowDeclarationsSchema,
  CLOUDFLARE_WORKFLOW_BUNDLE_VERSION,
  CLOUDFLARE_WORKFLOW_SPLIT_BUNDLE_VERSION,
  CLOUDFLARE_WORKFLOW_EXPORT,
} from '@stayingupwind/core/bundle';
import { UPWIND_CLOUDFLARE_WORKFLOWS_ENV } from '@stayingupwind/core/paas';

import { BlobStore } from './blobs.ts';
import type { FunctionDependencies } from './dependencies.ts';
import {
  type BundleOptions,
  type BundledDurableObject,
  buildWorkerClassFunctions,
  bundleWorkerClass,
} from './durable-objects.ts';
import type { SourceMapsOption } from './source-maps.ts';

export type BundledCloudflareWorkflow = Omit<BundledDurableObject, 'declaration'> & {
  readonly declaration: CloudflareWorkflowDeclaration;
};

/** Framework-independent class bundling. No application router or cache runtime is included. */
export async function bundleCloudflareWorkflows(
  projectDir: string,
  declarations: readonly CloudflareWorkflowDeclaration[],
  options: BundleOptions = {},
): Promise<BundledCloudflareWorkflow[]> {
  return Promise.all(
    cloudflareWorkflowDeclarationsSchema.parse(declarations).map((declaration) => {
      return bundleWorkerClass(projectDir, declaration, options, {
        description: 'Cloudflare Workflow',
        exportName: CLOUDFLARE_WORKFLOW_EXPORT,
      });
    }),
  );
}

/** Build content-addressed native Workflow modules and private debugging artifacts. */
export async function buildCloudflareWorkflowFunctions(input: {
  readonly projectDir: string;
  readonly outDir: string;
  readonly blobs?: BlobStore;
  readonly declarations: readonly CloudflareWorkflowDeclaration[];
  readonly sourceMaps?: SourceMapsOption;
  readonly distDir?: string;
}): Promise<{
  functions: Readonly<Record<string, FunctionSpec>>;
  sourceMaps: SourceMapRef[];
  dependencies: Readonly<Record<string, FunctionDependencies>>;
  declarations: CloudflareWorkflowDeclaration[];
}> {
  const declarations = cloudflareWorkflowDeclarationsSchema.parse(input.declarations);
  const blobs = input.blobs ?? new BlobStore(input.outDir);
  if (input.blobs === undefined) await blobs.init();
  const built = await buildWorkerClassFunctions(
    { ...input, blobs },
    await bundleCloudflareWorkflows(input.projectDir, declarations, input),
    {
      label: 'cloudflare-workflow',
      moduleName: 'cloudflare-workflow.mjs',
    },
  );
  return { ...built, declarations };
}

/** Hosts pass their sealed registrations explicitly; local builds use downloaded registrations. */
export async function cloudflareWorkflowParts(input: {
  readonly projectDir: string;
  readonly outDir: string;
  readonly blobs: BlobStore;
  readonly declarations: readonly CloudflareWorkflowDeclaration[] | undefined;
  readonly split: boolean;
  readonly sourceMaps?: SourceMapsOption;
  readonly distDir?: string;
}): Promise<{
  bundle: Partial<Pick<DeploymentBundle, 'v' | 'cloudflareWorkflows'>>;
  functions: Partial<Pick<DeploymentBundle['functions'], 'cloudflareWorkflows'>>;
  sourceMaps: SourceMapRef[];
  dependencies: Readonly<Record<string, FunctionDependencies>>;
}> {
  const raw = process.env[UPWIND_CLOUDFLARE_WORKFLOWS_ENV];
  let declarations: CloudflareWorkflowDeclaration[];
  try {
    declarations = cloudflareWorkflowDeclarationsSchema.parse(
      input.declarations ?? (raw === undefined || raw === '' ? [] : (JSON.parse(raw) as unknown)),
    );
  } catch (error) {
    throw new Error('@stayingupwind/adapter: invalid Cloudflare Workflow declarations', {
      cause: error,
    });
  }
  if (declarations.length === 0)
    return { bundle: {}, functions: {}, sourceMaps: [], dependencies: {} };
  const built = await buildCloudflareWorkflowFunctions({
    ...input,
    declarations,
    distDir: input.distDir ?? path.join(input.projectDir, '.next'),
  });
  return {
    bundle: {
      v: input.split
        ? CLOUDFLARE_WORKFLOW_SPLIT_BUNDLE_VERSION
        : CLOUDFLARE_WORKFLOW_BUNDLE_VERSION,
      cloudflareWorkflows: declarations,
    },
    functions: { cloudflareWorkflows: built.functions },
    sourceMaps: built.sourceMaps,
    dependencies: built.dependencies,
  };
}
