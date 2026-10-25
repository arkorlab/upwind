/* eslint-disable unicorn/no-keyword-prefix -- Matches the host registration className field. */
import { describe, expect, it } from 'vitest';

import { cloudflareWorkflowDeclarationsSchema } from '../src/bundle/cloudflare-workflows.ts';
import { bundleBlobs, deploymentBundleSchema } from '../src/bundle/schema.ts';
import { resourcesOf, RESOURCES_MANIFEST_BINDING } from '../src/paas/resources.ts';
import { createId } from '../src/util/index.ts';

const declaration = { name: 'JOBS', module: 'src/jobs.ts', className: 'Job' };
const blob = { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/javascript' };
const fn = {
  mainModule: 'job.mjs',
  modules: [{ name: 'job.mjs', type: 'esm', blob }],
  compatibilityDate: '2026-09-15',
  compatibilityFlags: [],
};
function bundle() {
  return {
    v: 9,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: '2026-10-24T00:00:00.000Z',
    routerReferences: 'one-pass',
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: false,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'rsc',
        varyHeader: 'rsc',
        prefetchHeader: 'prefetch',
        didPostponeHeader: 'postpone',
        contentTypeHeader: 'content-type',
        suffix: '.rsc',
        prefetchSegmentHeader: 'next-router-segment-prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: [],
    prerenders: [],
    staticFiles: [],
    cloudflareWorkflows: [declaration],
    functions: { app: { ...fn, modules: [] }, cloudflareWorkflows: { JOBS: fn } },
  };
}

describe('cloudflare Workflow bundle and resource contracts', () => {
  it('admits independently named declarations without an arbitrary per-project class cap', () => {
    const declarations = Array.from({ length: 11 }, (_, index) => {
      const name = `JOBS_${String(index)}`;
      return { ...declaration, name };
    });

    expect(cloudflareWorkflowDeclarationsSchema.parse(declarations)).toStrictEqual(declarations);
    expect(cloudflareWorkflowDeclarationsSchema.safeParse([declaration, declaration]).success).toBe(
      false,
    );
  });

  it('validates declarations and reserves traversal and prototype names', () => {
    expect(cloudflareWorkflowDeclarationsSchema.parse([declaration])).toStrictEqual([declaration]);

    for (const module of ['../job.ts', '/job.ts', 'dir/./job.ts', String.raw`dir\job.ts`])
      expect(
        cloudflareWorkflowDeclarationsSchema.safeParse([{ ...declaration, module }]).success,
      ).toBe(false);

    expect(
      cloudflareWorkflowDeclarationsSchema.safeParse([{ ...declaration, name: '__proto__' }])
        .success,
    ).toBe(false);
  });

  it('keeps Container configuration on Durable Object declarations', () => {
    expect(
      cloudflareWorkflowDeclarationsSchema.safeParse([
        {
          ...declaration,
          container: {
            image: { reference: 'alpine:3.22' },
            instanceType: 'lite',
            maxInstances: 1,
          },
        },
      ]).success,
    ).toBe(false);
  });

  it.each([
    { v: 7, split: false, workflows: false },
    { v: 8, split: true, workflows: false },
    { v: 9, split: false, workflows: true },
    { v: 10, split: true, workflows: true },
  ])(
    'keeps Container and Workflow capabilities distinct at version $v',
    ({ v, split, workflows }) => {
      const input = bundle();
      const objects = [
        {
          ...declaration,
          name: 'COMPUTE',
          container: {
            image: { reference: 'alpine:3.22' },
            instanceType: 'lite',
            maxInstances: 1,
          },
        },
      ];
      const configured = {
        ...input,
        v,
        cloudflareWorkflows: workflows ? input.cloudflareWorkflows : undefined,
        durableObjects: objects,
        entrypoints: split
          ? [{ id: 'app/run/route', kind: 'app-route', pathname: '/run', function: 'app-2' }]
          : [],
        functions: {
          app: input.functions.app,
          ...(split && { split: { 'app-2': fn } }),
          durableObjects: { COMPUTE: fn },
          ...(workflows && { cloudflareWorkflows: input.functions.cloudflareWorkflows }),
        },
      };
      const parsed = deploymentBundleSchema.parse(configured);

      expect(parsed.v).toBe(v);
      expect(parsed.durableObjects).toStrictEqual(objects);
      expect(
        deploymentBundleSchema.safeParse({
          ...configured,
          cloudflareWorkflows: input.cloudflareWorkflows,
          functions: {
            ...configured.functions,
            cloudflareWorkflows: input.functions.cloudflareWorkflows,
          },
        }).success,
      ).toBe(workflows);
    },
  );

  it('requires a matching new-version artifact map and includes every workflow blob', () => {
    const input = bundle();
    const parsed = deploymentBundleSchema.parse(input);

    expect(bundleBlobs(parsed).get(blob.sha256)).toStrictEqual(blob);
    expect(deploymentBundleSchema.safeParse({ ...input, v: 3 }).success).toBe(false);
    expect(deploymentBundleSchema.safeParse({ ...input, functions: { app: fn } }).success).toBe(
      false,
    );
    expect(deploymentBundleSchema.safeParse({ ...input, cloudflareWorkflows: [] }).success).toBe(
      false,
    );
    expect(
      deploymentBundleSchema.safeParse({
        ...input,
        durableObjects: [{ ...declaration, name: 'OBJECT' }],
        functions: { ...input.functions, durableObjects: { OBJECT: fn } },
      }).success,
    ).toBe(true);
  });

  it('rejects a binding name shared by a Workflow and Durable Object', () => {
    const input = bundle();

    expect(
      deploymentBundleSchema.safeParse({
        ...input,
        durableObjects: [declaration],
        functions: { ...input.functions, durableObjects: { JOBS: fn } },
      }).error?.message,
    ).toContain('conflicts with a Durable Object binding');
  });

  it('publishes a scoped Workflow bridge without invoking or exposing unlisted bindings', () => {
    const bridge = {
      invoke: () => {
        throw new Error('lookup must make no call');
      },
    };
    const result = resourcesOf({
      [RESOURCES_MANIFEST_BINDING]: JSON.stringify([{ name: 'JOBS', type: 'workflow' }]),
      JOBS: bridge,
      PRIVATE: bridge,
    });

    expect(result.resources['JOBS']?.binding).toBe(bridge);
    expect(Object.keys(result.resources)).toStrictEqual(['JOBS']);
  });
});
