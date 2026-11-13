import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  fargateDirectory,
  nativeDeploymentId,
  nativeStaticFiles,
  nativeTreeSha256,
  readFargateBuild,
  safeNativeStaticBypass,
  sha256File,
  writeFargateReceipt,
} from '../src/aws/receipt.ts';
import { awsDeploySettings } from '../src/aws/settings.ts';
import type { FargateBuildReceipt } from '../src/aws/types.ts';
import { ownVersion } from '../src/manifest.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function routing(): Record<string, unknown> {
  return Object.fromEntries(
    [
      'beforeMiddleware',
      'middlewareMatchers',
      'beforeFiles',
      'afterFiles',
      'dynamicRoutes',
      'onMatch',
      'fallback',
    ].map((phase) => [phase, []]),
  );
}

async function artifact(): Promise<{
  readonly projectDir: string;
  readonly receipt: FargateBuildReceipt;
}> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'upwind-fargate-receipt-'));
  directories.push(projectDir);
  const directory = fargateDirectory(projectDir);
  const nativeDirectory = path.join(directory, 'native');
  await mkdir(path.join(nativeDirectory, 'blobs'), { recursive: true });
  const deploymentId = createId(DEPLOYMENT_ID_PREFIX);
  const bytes = Buffer.from('immutable asset');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(nativeDirectory, 'blobs', sha256), bytes);
  await writeFile(
    path.join(nativeDirectory, 'manifest.json'),
    JSON.stringify({ format: 'upwind-node', v: 1, aws: 1, deploymentId }),
  );
  await writeFile(
    path.join(nativeDirectory, 'build-runtime.json'),
    JSON.stringify({
      nodeVersion: '26.13.0',
      nodeAbi: '150',
      platform: 'linux',
      architecture: 'x64',
    }),
  );
  await writeFile(
    path.join(nativeDirectory, 'runtime.json'),
    JSON.stringify({
      config: { basePath: '' },
      routing: routing(),
      staticFiles: [
        {
          pathname: '/_next/static/asset.js',
          immutable: true,
          blob: { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript' },
        },
      ],
    }),
  );
  const archivePath = path.join(directory, 'image.tar');
  await writeFile(archivePath, 'archive content');
  const receipt: FargateBuildReceipt = {
    compute: 'fargate',
    format: 'upwind-fargate',
    version: 1,
    deploymentId,
    upwind: (await ownVersion()) ?? '',
    builtAt: new Date().toISOString(),
    platform: 'linux/amd64',
    imageId: `sha256:${'a'.repeat(64)}`,
    baseImageDigest: `node@sha256:${'b'.repeat(64)}`,
    nodeVersion: '26.13.0',
    nodeAbi: '150',
    archivePath,
    archiveSha256: await sha256File(archivePath),
    nativeDirectory,
    nativeSha256: await nativeTreeSha256(nativeDirectory),
    staticFiles: await nativeStaticFiles(nativeDirectory),
    safeStaticBypass: true,
  };
  await writeFargateReceipt(projectDir, receipt);
  return { projectDir, receipt };
}

describe('Fargate prebuilt integrity', () => {
  it('reconstructs local upload paths from a portable verified native artifact', async () => {
    const { projectDir, receipt } = await artifact();
    const persisted = await readFile(
      path.join(fargateDirectory(projectDir), 'deployment.json'),
      'utf8',
    );
    expect(persisted).not.toContain(projectDir);
    expect(
      await readFargateBuild({ projectDir, settings: awsDeploySettings({ region: 'us-east-1' }) }),
    ).toEqual(receipt);
    await expect(
      readFargateBuild({
        projectDir,
        settings: awsDeploySettings({ region: 'us-east-1', architecture: 'arm64' }),
      }),
    ).rejects.toThrow('incompatible');
  });

  it('refuses modified image archives and native source files', async () => {
    const first = await artifact();
    await writeFile(first.receipt.archivePath, 'modified');
    await expect(
      readFargateBuild({
        projectDir: first.projectDir,
        settings: awsDeploySettings({ region: 'us-east-1' }),
      }),
    ).rejects.toThrow('integrity');
    const second = await artifact();
    await writeFile(
      path.join(second.receipt.nativeDirectory, 'server.mjs'),
      'modified native code',
    );
    await expect(
      readFargateBuild({
        projectDir: second.projectDir,
        settings: awsDeploySettings({ region: 'us-east-1' }),
      }),
    ).rejects.toThrow('integrity');
  });

  it('does not accept an ordinary Node build as an AWS deployment', async () => {
    const { receipt } = await artifact();
    await writeFile(
      path.join(receipt.nativeDirectory, 'manifest.json'),
      JSON.stringify({ format: 'upwind-node', v: 1, deploymentId: receipt.deploymentId }),
    );
    await expect(nativeDeploymentId(receipt.nativeDirectory)).rejects.toThrow('AWS-enabled');
  });

  it('rejects changed compute or Node ABI claims in an otherwise intact receipt', async () => {
    const { projectDir } = await artifact();
    const file = path.join(fargateDirectory(projectDir), 'deployment.json');
    const original = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...original, nodeAbi: '9999' }));
    await expect(
      readFargateBuild({ projectDir, settings: awsDeploySettings({ region: 'us-east-1' }) }),
    ).rejects.toThrow('ABI');
    await writeFile(file, JSON.stringify({ ...original, compute: 'lambda' }));
    await expect(
      readFargateBuild({ projectDir, settings: awsDeploySettings({ region: 'us-east-1' }) }),
    ).rejects.toThrow('incompatible');
  });

  it('revokes whole-prefix CDN bypass for middleware, headers, rewrites, or non-root assets', async () => {
    const { receipt } = await artifact();
    const file = path.join(receipt.nativeDirectory, 'runtime.json');
    const clean = { config: { basePath: '' }, routing: routing() };
    expect(await safeNativeStaticBypass(receipt.nativeDirectory)).toBe(true);
    for (const protectedRuntime of [
      { ...clean, middleware: { matchers: [] } },
      { ...clean, config: { basePath: '/shop' } },
      { ...clean, config: { basePath: '', assetPrefix: '/cdn' } },
      {
        ...clean,
        routing: { ...routing(), beforeFiles: [{ sourceRegex: '.*', destination: '/private' }] },
      },
      {
        ...clean,
        routing: {
          ...routing(),
          onMatch: [{ sourceRegex: '.*', headers: [['cache-control', 'private']] }],
        },
      },
    ]) {
      await writeFile(file, JSON.stringify(protectedRuntime));
      expect(await safeNativeStaticBypass(receipt.nativeDirectory)).toBe(false);
    }
  });
});
