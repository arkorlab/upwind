import { describe, expect, it } from 'vitest';

import {
  bundleBlobs,
  deploymentBundleSchema,
  isNodeContainerFunction,
  type DeploymentBundle,
  type NodeContainerFunctionSpec,
  workerFunctionSchema,
} from '../src/bundle/schema.ts';
import { fixtureBundle } from './fixtures/bundle.ts';

const NODE: NodeContainerFunctionSpec = {
  runtime: 'node-container',
  entrypoint: 'upwind/server.mjs',
  artifact: { sha256: '9'.repeat(64), byteLength: 4096, contentType: 'application/gzip' },
  abi: { nodeVersion: '24.22.1', nodeAbi: '137', platform: 'linux', arch: 'x64', libc: 'glibc' },
};

function nativeBundle(): DeploymentBundle {
  return { ...fixtureBundle(), v: 11, routerReferences: 'one-pass', functions: { app: NODE } };
}

describe('node Function bundle contract', () => {
  it('keeps ordinary Worker JSON unchanged and refuses unknown runtime discriminators', () => {
    const app = fixtureBundle().functions.app;

    expect(JSON.stringify(workerFunctionSchema.parse(app))).toBe(JSON.stringify(app));
    expect(workerFunctionSchema.safeParse({ ...app, runtime: 'other' }).success).toBe(false);
    expect(isNodeContainerFunction(app)).toBe(false);
  });

  it('requires an explicit supported version before a host can accept a native artifact', () => {
    expect(deploymentBundleSchema.safeParse(nativeBundle()).success).toBe(true);

    for (const v of [1, 3, 5, 7, 9]) {
      expect(deploymentBundleSchema.safeParse({ ...nativeBundle(), v }).success).toBe(false);
    }

    expect(
      deploymentBundleSchema.safeParse({ ...fixtureBundle(), v: 11, routerReferences: 'one-pass' })
        .success,
    ).toBe(false);
  });

  it('supports mixed app placement at version 12 without moving the Worker app', () => {
    const original = fixtureBundle();
    const split: DeploymentBundle = {
      ...original,
      v: 12,
      routerReferences: 'one-pass',
      entrypoints: original.entrypoints.map((entry, index) =>
        index === 0 ? { ...entry, function: 'app-2' } : entry,
      ),
      functions: { ...original.functions, split: { 'app-2': NODE } },
    };
    const result = deploymentBundleSchema.parse(split);

    expect(isNodeContainerFunction(result.functions.app)).toBe(false);
    expect(isNodeContainerFunction(result.functions.split!['app-2']!)).toBe(true);
    expect(deploymentBundleSchema.safeParse({ ...split, v: 11 }).success).toBe(false);
  });

  it('does not reinterpret middleware or native class owners as Node Containers', () => {
    for (const functions of [
      { app: NODE, middleware: NODE },
      { app: NODE, durableObjects: { OBJECT: NODE } },
      { app: NODE, workflow: NODE },
    ]) {
      expect(deploymentBundleSchema.safeParse({ ...nativeBundle(), functions }).success).toBe(
        false,
      );
    }
  });

  it('collects the archive and refuses conflicting lengths across archive and public files', () => {
    const bundle = nativeBundle();

    expect(bundleBlobs(bundle).get(NODE.artifact.sha256)).toStrictEqual(NODE.artifact);
    expect(
      deploymentBundleSchema.safeParse({
        ...bundle,
        staticFiles: [
          {
            pathname: '/same.gz',
            immutable: true,
            blob: { ...NODE.artifact, byteLength: NODE.artifact.byteLength + 1 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects mismatched artifact fields rather than treating them as Worker modules', () => {
    for (const change of [
      { entrypoint: '../server.mjs' },
      { artifact: { ...NODE.artifact, contentType: 'text/javascript' } },
      { abi: { ...NODE.abi, arch: 'arm64' } },
      { mainModule: 'index.mjs', modules: [] },
    ]) {
      expect(
        deploymentBundleSchema.safeParse({
          ...nativeBundle(),
          functions: { app: { ...NODE, ...change } },
        }).success,
      ).toBe(false);
    }
  });
});
