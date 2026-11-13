import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { deploymentIdSchema, staticFileSchema } from '@stayingupwind/core/bundle';

import { ownVersion } from '../manifest.ts';
import type { AwsDeploySettings, AwsStaticFile, FargateBuildReceipt } from './types.ts';

const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;

export function fargateDirectory(projectDir: string): string {
  return path.join(projectDir, '.arkor', 'fargate');
}

export function fargatePlatform(
  settings: Pick<AwsDeploySettings, 'architecture'>,
): 'linux/amd64' | 'linux/arm64' {
  return settings.architecture === 'arm64' ? 'linux/arm64' : 'linux/amd64';
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** Every file and symlink is included, so a prebuilt cannot silently swap its extracted assets. */
export async function nativeTreeSha256(directory: string): Promise<string> {
  const root = await realpath(directory);
  const hash = createHash('sha256');
  const walk = async (at: string): Promise<void> => {
    const entries = (await readdir(at)).toSorted();
    for (const name of entries) {
      const file = path.join(at, name);
      const info = await lstat(file);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (info.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        await walk(file);
      } else if (info.isSymbolicLink()) {
        const target = await readlink(file);
        if (!inside(root, await realpath(file)))
          throw new Error('native artifact has a symlink outside its directory');
        hash.update(`symlink\0${relative}\0${target}\0`);
      } else if (info.isFile()) {
        hash.update(`file\0${relative}\0${String(info.mode & 0o777)}\0${await sha256File(file)}\0`);
      } else {
        throw new Error('native artifact contains a file that is not a regular file or symlink');
      }
    }
  };
  await walk(root);
  return hash.digest('hex');
}

export async function nativeDeploymentId(directory: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('format' in parsed) ||
    parsed.format !== 'upwind-node' ||
    !('v' in parsed) ||
    parsed.v !== 1 ||
    !('aws' in parsed) ||
    parsed.aws !== 1 ||
    !('deploymentId' in parsed)
  ) {
    throw new Error('the image does not contain an AWS-enabled upwind native artifact');
  }
  return deploymentIdSchema.parse(parsed.deploymentId);
}

export async function nativeRuntimeMetadata(directory: string): Promise<{
  readonly nodeVersion: string;
  readonly nodeAbi: string;
  readonly platform: 'linux/amd64' | 'linux/arm64';
}> {
  const raw: unknown = JSON.parse(
    await readFile(path.join(directory, 'build-runtime.json'), 'utf8'),
  );
  if (typeof raw !== 'object' || raw === null)
    throw new Error('native build has no Node.js runtime metadata');
  const value = raw as Record<string, unknown>;
  if (
    typeof value['nodeVersion'] !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(value['nodeVersion']) ||
    typeof value['nodeAbi'] !== 'string' ||
    !/^\d+$/u.test(value['nodeAbi']) ||
    value['platform'] !== 'linux' ||
    (value['architecture'] !== 'x64' && value['architecture'] !== 'arm64')
  ) {
    throw new Error('native build has invalid Node.js version, ABI, or platform metadata');
  }
  return {
    nodeVersion: value['nodeVersion'],
    nodeAbi: value['nodeAbi'],
    platform: value['architecture'] === 'arm64' ? 'linux/arm64' : 'linux/amd64',
  };
}

export async function nativeStaticFiles(directory: string): Promise<readonly AwsStaticFile[]> {
  const parsed: unknown = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('staticFiles' in parsed) ||
    !Array.isArray(parsed.staticFiles)
  ) {
    throw new Error('the native artifact has no static-file manifest');
  }
  const root = await realpath(directory);
  const result: AwsStaticFile[] = [];
  for (const raw of parsed.staticFiles as unknown[]) {
    const entry = staticFileSchema.parse(raw);
    if (!entry.immutable || !entry.pathname.includes('/_next/static/')) continue;
    const url = new URL(entry.pathname, 'https://upwind.invalid');
    if (
      url.pathname !== entry.pathname ||
      url.search !== '' ||
      url.hash !== '' ||
      entry.pathname.includes('\\')
    ) {
      throw new Error('native artifact contains an unsafe static-file path');
    }
    const file = path.join(directory, 'blobs', entry.blob.sha256);
    const resolved = await realpath(file);
    if (!inside(root, resolved)) throw new Error('native static file escapes its artifact');
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.size !== entry.blob.byteLength ||
      (await sha256File(file)) !== entry.blob.sha256
    ) {
      throw new Error(`native static file failed its content digest: ${entry.pathname}`);
    }
    result.push({
      path: entry.pathname,
      file,
      sha256: entry.blob.sha256,
      byteLength: entry.blob.byteLength,
      contentType: entry.blob.contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    });
  }
  return result;
}

/** A whole-prefix CDN behavior is safe only when no application routing can affect it. */
export async function safeNativeStaticBypass(directory: string): Promise<boolean> {
  const raw: unknown = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'));
  if (typeof raw !== 'object' || raw === null) return false;
  const value = raw as Record<string, unknown>;
  if (value['middleware'] !== undefined) return false;
  const config = value['config'];
  const routing = value['routing'];
  if (
    typeof config !== 'object' ||
    config === null ||
    typeof routing !== 'object' ||
    routing === null
  )
    return false;
  const configuration = config as Record<string, unknown>;
  if (
    configuration['basePath'] !== '' ||
    configuration['assetPrefix'] !== undefined ||
    configuration['i18n'] != null
  )
    return false;
  const phases = routing as Record<string, unknown>;
  return [
    'beforeMiddleware',
    'middlewareMatchers',
    'beforeFiles',
    'afterFiles',
    'dynamicRoutes',
    'onMatch',
    'fallback',
  ].every((key) => Array.isArray(phases[key]) && phases[key].length === 0);
}

/** Paths on disk are relative so the whole directory can be passed to another machine. */
export async function writeFargateReceipt(
  projectDir: string,
  receipt: FargateBuildReceipt,
): Promise<void> {
  const directory = fargateDirectory(projectDir);
  const relativeFile = (file: string): string => {
    if (!inside(directory, file))
      throw new Error('Fargate receipt references a file outside its artifact');
    return path.relative(directory, file).split(path.sep).join('/');
  };
  await writeFile(
    path.join(directory, 'deployment.json'),
    `${JSON.stringify(
      {
        ...receipt,
        archivePath: relativeFile(receipt.archivePath),
        nativeDirectory: relativeFile(receipt.nativeDirectory),
        staticFiles: receipt.staticFiles.map((file) => ({
          ...file,
          file: relativeFile(file.file),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

export async function readFargateBuild(input: {
  readonly projectDir: string;
  readonly settings: AwsDeploySettings;
}): Promise<FargateBuildReceipt> {
  const directory = fargateDirectory(input.projectDir);
  const raw: unknown = JSON.parse(await readFile(path.join(directory, 'deployment.json'), 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error('invalid Fargate build receipt');
  const value = raw as Record<string, unknown>;
  const upwind = await ownVersion();
  if (
    value['compute'] !== 'fargate' ||
    value['format'] !== 'upwind-fargate' ||
    value['version'] !== 1 ||
    value['platform'] !== fargatePlatform(input.settings) ||
    typeof value['imageId'] !== 'string' ||
    !IMAGE.test(value['imageId']) ||
    typeof value['archiveSha256'] !== 'string' ||
    !SHA256.test(value['archiveSha256']) ||
    typeof value['nativeSha256'] !== 'string' ||
    !SHA256.test(value['nativeSha256']) ||
    typeof value['baseImageDigest'] !== 'string' ||
    !/^node@sha256:[a-f0-9]{64}$/u.test(value['baseImageDigest']) ||
    typeof value['builtAt'] !== 'string' ||
    !Number.isFinite(Date.parse(value['builtAt'])) ||
    typeof value['upwind'] !== 'string' ||
    upwind === undefined ||
    value['upwind'] !== upwind ||
    value['archivePath'] !== 'image.tar' ||
    value['nativeDirectory'] !== 'native'
  ) {
    throw new Error(
      'Fargate prebuilt is incompatible; rebuild with this upwind version and target architecture',
    );
  }
  const deploymentId = deploymentIdSchema.parse(value['deploymentId']);
  const archivePath = path.join(directory, 'image.tar');
  const nativeDirectory = path.join(directory, 'native');
  if (
    !(await lstat(nativeDirectory)).isDirectory() ||
    !inside(await realpath(directory), await realpath(nativeDirectory))
  ) {
    throw new Error('Fargate native artifact is not a directory within its build');
  }
  if (
    !(await lstat(archivePath)).isFile() ||
    !inside(await realpath(directory), await realpath(archivePath))
  ) {
    throw new Error('Fargate image archive is not a regular artifact file');
  }
  if (
    (await sha256File(archivePath)) !== value['archiveSha256'] ||
    (await nativeTreeSha256(nativeDirectory)) !== value['nativeSha256'] ||
    (await nativeDeploymentId(nativeDirectory)) !== deploymentId
  ) {
    throw new Error('Fargate prebuilt failed its image or native-artifact integrity check');
  }
  const staticFiles = await nativeStaticFiles(nativeDirectory);
  const runtime = await nativeRuntimeMetadata(nativeDirectory);
  if (
    value['nodeVersion'] !== runtime.nodeVersion ||
    value['nodeAbi'] !== runtime.nodeAbi ||
    runtime.platform !== value['platform']
  ) {
    throw new Error(
      'Fargate prebuilt Node.js version, ABI, or platform does not match its image artifact',
    );
  }
  const safeStaticBypass = await safeNativeStaticBypass(nativeDirectory);
  if (value['safeStaticBypass'] !== safeStaticBypass)
    throw new Error('Fargate static-delivery proof does not match its native artifact');
  // Reconstruct the upload list from the verified native manifest, never from receipt paths.
  return {
    compute: 'fargate',
    format: 'upwind-fargate',
    version: 1,
    deploymentId,
    upwind,
    builtAt: value['builtAt'],
    platform: fargatePlatform(input.settings),
    imageId: value['imageId'],
    baseImageDigest: value['baseImageDigest'],
    nodeVersion: runtime.nodeVersion,
    nodeAbi: runtime.nodeAbi,
    archivePath,
    archiveSha256: value['archiveSha256'],
    nativeDirectory,
    nativeSha256: value['nativeSha256'],
    staticFiles,
    safeStaticBypass,
  };
}
