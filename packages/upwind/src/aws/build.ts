import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';

import { ownVersion } from '../manifest.ts';
import { buildDirectories, copyBuildContext, packageInstall } from './build-context.ts';
import { buildScript, dockerfile } from './build-source.ts';
import { runCommand } from './process.ts';
import {
  fargateDirectory,
  fargatePlatform,
  nativeDeploymentId,
  nativeRuntimeMetadata,
  nativeStaticFiles,
  nativeTreeSha256,
  safeNativeStaticBypass,
  sha256File,
  writeFargateReceipt,
} from './receipt.ts';
import type { AwsDeploySettings, FargateBuildReceipt } from './types.ts';

export { readFargateBuild } from './receipt.ts';
export type { FargateBuildReceipt } from './types.ts';

const NODE_IMAGE = 'node:26.13.0-bookworm-slim';

async function baseImage(platform: string): Promise<string> {
  await runCommand('docker', ['pull', '--platform', platform, NODE_IMAGE]);
  const raw: unknown = JSON.parse(
    await runCommand('docker', [
      'image',
      'inspect',
      '--format',
      '{{json .RepoDigests}}',
      NODE_IMAGE,
    ]),
  );
  if (!Array.isArray(raw)) throw new Error('Docker returned no immutable Node base-image digest');
  const digest = (raw as unknown[]).find(
    (value): value is string =>
      typeof value === 'string' && /(?:^|\/)node@sha256:[a-f0-9]{64}$/u.test(value),
  );
  if (digest === undefined) throw new Error('Docker returned no immutable Node base-image digest');
  return `node@${digest.split('@')[1] ?? ''}`;
}

/** No AWS client or credential provider is imported by this build-only path. */
export async function buildFargate(input: {
  readonly projectDir: string;
  readonly settings: AwsDeploySettings;
  readonly deploymentId?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<FargateBuildReceipt> {
  const { settings } = input;
  const directories = await buildDirectories(input.projectDir, settings.build.context);
  const install = await packageInstall(directories.context);
  if (settings.build.prepare !== undefined && settings.build.prepare.length === 0)
    throw new Error('build.prepare must contain a command');
  const env: Record<string, string> = {};
  for (const name of settings.build.env) {
    if (
      !/^[A-Z_a-z][A-Z_a-z0-9]*$/u.test(name) ||
      /^(?:AWS_|AMAZON_|CF_|CLOUDFLARE_|UPWIND_|ARKOR_)/u.test(name)
    ) {
      throw new Error(
        `build.env cannot expose deployment credentials or reserved variables: ${name}`,
      );
    }
    const value = (input.env ?? process.env)[name];
    if (value === undefined)
      throw new Error(`declared build environment variable is unset: ${name}`);
    env[name] = value;
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'upwind-fargate-build-'));
  const output = fargateDirectory(directories.project);
  const deploymentId = input.deploymentId ?? createId(DEPLOYMENT_ID_PREFIX);
  const token = randomUUID();
  const imageTag = `upwind-build:${token}`;
  const containerName = `upwind-build-${token}`;
  let created = false;
  let built = false;
  try {
    const platform = fargatePlatform(settings);
    const baseImageDigest = await baseImage(platform);
    const context = path.join(temporary, 'context');
    await mkdir(context);
    await copyBuildContext(directories.context, path.join(context, 'source'));
    await writeFile(
      path.join(context, 'build.mjs'),
      buildScript({
        install,
        project: directories.relativeProject,
        deploymentId,
        ...(settings.build.prepare === undefined ? {} : { prepare: settings.build.prepare }),
      }),
    );
    await writeFile(
      path.join(context, 'Dockerfile'),
      dockerfile({ baseImageDigest, project: directories.relativeProject, deploymentId }),
    );
    const secret = path.join(temporary, 'build-environment.json');
    await writeFile(secret, JSON.stringify(env), { mode: 0o600 });
    await runCommand('docker', [
      'buildx',
      'build',
      '--platform',
      platform,
      '--load',
      '--tag',
      imageTag,
      '--secret',
      `id=upwind-build-env,src=${secret}`,
      '--iidfile',
      path.join(temporary, 'image-id'),
      context,
    ]);
    built = true;
    const imageId = (await readFile(path.join(temporary, 'image-id'), 'utf8')).trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId))
      throw new Error('Docker returned an invalid image ID');
    const architecture = await runCommand('docker', [
      'image',
      'inspect',
      '--format',
      '{{.Os}}/{{.Architecture}}',
      imageId,
    ]);
    if (architecture !== platform)
      throw new Error('Docker built an image for a different platform');
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    await runCommand('docker', ['create', '--name', containerName, imageId]);
    created = true;
    const nativeDirectory = path.join(output, 'native');
    await mkdir(nativeDirectory);
    await runCommand('docker', ['cp', `${containerName}:/app/.`, nativeDirectory]);
    if ((await nativeDeploymentId(nativeDirectory)) !== deploymentId)
      throw new Error('the image contains another native deployment');
    const archivePath = path.join(output, 'image.tar');
    await runCommand('docker', ['image', 'save', '--output', archivePath, imageId]);
    const runtime = await nativeRuntimeMetadata(nativeDirectory);
    if (runtime.platform !== platform)
      throw new Error('the native artifact was built for another platform');
    const receipt: FargateBuildReceipt = {
      compute: 'fargate',
      format: 'upwind-fargate',
      version: 1,
      deploymentId,
      upwind: (await ownVersion()) ?? 'unknown',
      builtAt: new Date().toISOString(),
      platform,
      imageId,
      baseImageDigest,
      nodeVersion: runtime.nodeVersion,
      nodeAbi: runtime.nodeAbi,
      archivePath,
      archiveSha256: await sha256File(archivePath),
      nativeDirectory,
      nativeSha256: await nativeTreeSha256(nativeDirectory),
      staticFiles: await nativeStaticFiles(nativeDirectory),
      safeStaticBypass: await safeNativeStaticBypass(nativeDirectory),
    };
    await writeFargateReceipt(directories.project, receipt);
    return receipt;
  } finally {
    if (created)
      await runCommand('docker', ['container', 'rm', containerName], { quiet: true }).catch(
        () => undefined,
      );
    if (built)
      await runCommand('docker', ['image', 'rm', imageTag], { quiet: true }).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}
