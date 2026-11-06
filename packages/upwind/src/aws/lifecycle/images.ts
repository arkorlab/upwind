import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BatchDeleteImageCommand,
  BatchGetImageCommand,
  DescribeImagesCommand,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import { verifyFargateArchive } from '../build-verify.ts';
import { runCommand } from '../process.ts';
import type { AwsBootstrapOutputs, FargateBuildReceipt } from '../types.ts';
import { mutation, type AwsContext, type AwsLifecycleIo } from './sdk.ts';

async function heldImage(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  receipt: FargateBuildReceipt,
): Promise<string | undefined> {
  const response = await context.services.ecr.send(
    new BatchGetImageCommand({
      repositoryName: bootstrap.RepositoryName,
      imageIds: [{ imageTag: receipt.deploymentId }],
      acceptedMediaTypes: [
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ],
    }),
  );
  const image = response.images?.[0];
  if (image === undefined) {
    if (response.failures?.some((failure) => failure.failureCode !== 'ImageNotFound'))
      throw new Error('ECR could not inspect this deployment image');
    return undefined;
  }
  const manifest = JSON.parse(image.imageManifest ?? '{}') as { config?: { digest?: string } };
  const digest = image.imageId?.imageDigest;
  if (
    manifest.config?.digest !== receipt.imageId ||
    digest === undefined ||
    !/^sha256:[a-f\d]{64}$/u.test(digest)
  )
    throw new Error('ECR already holds a different image under this deployment ID');
  return `${bootstrap.RepositoryUri}@${digest}`;
}

export async function pushImage(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  receipt: FargateBuildReceipt,
  io: AwsLifecycleIo,
): Promise<string> {
  const existing = await heldImage(context, bootstrap, receipt);
  if (existing !== undefined) return existing;
  const configuration = await mkdtemp(path.join(tmpdir(), 'upwind-ecr-'));
  const run = async (args: readonly string[], input?: string): Promise<void> => {
    if (io.run !== undefined) {
      await io.run('docker', ['--config', configuration, ...args], input);
      return;
    }
    await runCommand('docker', ['--config', configuration, ...args], {
      ...(input === undefined ? {} : { input }),
      quiet: true,
    });
  };
  try {
    const authorization = await context.services.ecr.send(new GetAuthorizationTokenCommand({}));
    const data = authorization.authorizationData?.[0];
    if (data?.authorizationToken === undefined || data.proxyEndpoint === undefined)
      throw new Error('ECR returned no registry credentials');
    const decoded = Buffer.from(data.authorizationToken, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 1) throw new Error('ECR returned invalid registry credentials');
    await run(
      ['login', '--username', decoded.slice(0, colon), '--password-stdin', data.proxyEndpoint],
      decoded.slice(colon + 1),
    );
    const tag = `${bootstrap.RepositoryUri}:${receipt.deploymentId}`;
    await run(['tag', receipt.imageId, tag]);
    await run(['push', tag]);
    const image = await context.services.ecr.send(
      new DescribeImagesCommand({
        repositoryName: bootstrap.RepositoryName,
        imageIds: [{ imageTag: receipt.deploymentId }],
      }),
    );
    const digest = image.imageDetails?.[0]?.imageDigest;
    if (digest === undefined || !/^sha256:[a-f\d]{64}$/u.test(digest))
      throw new Error('ECR did not confirm an immutable digest for the uploaded image');
    const confirmed = await heldImage(context, bootstrap, receipt);
    if (confirmed === undefined || !confirmed.endsWith(`@${digest}`))
      throw new Error('ECR image identity was not confirmed after push');
    return confirmed;
  } finally {
    await rm(configuration, { recursive: true, force: true });
  }
}

/** Load only an authenticated local archive and verify the actual image, before provisioning. */
export async function validateImage(
  receipt: FargateBuildReceipt,
  io: AwsLifecycleIo,
): Promise<void> {
  await verifyFargateArchive(
    receipt,
    io.run === undefined
      ? runCommand
      : (command, args, options) =>
          io.run!(command, args, typeof options?.input === 'string' ? options.input : undefined),
  );
}

export async function uploadStatic(
  context: AwsContext,
  bucket: string,
  receipt: FargateBuildReceipt,
): Promise<void> {
  const files: {
    pathname: string;
    blob: { sha256: string; byteLength: number; contentType: string };
    immutable: true;
  }[] = [];
  for (const file of receipt.staticFiles) {
    if (
      !file.path.startsWith('/') ||
      !file.path.includes('/_next/static/') ||
      file.path.split('/').includes('..')
    )
      continue;
    const bytes = await readFile(file.file);
    if (
      bytes.byteLength !== file.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new Error(`the build's static file ${file.path} differs from its receipt`);
    try {
      await mutation(`upload ${file.path}`, () =>
        context.services.objects.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `static${file.path}`,
            Body: createReadStream(file.file),
            ContentLength: file.byteLength,
            ContentType: file.contentType,
            CacheControl: 'public, max-age=31536000, immutable',
            Metadata: { sha256: file.sha256 },
            IfNoneMatch: '*',
          }),
        ),
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'PreconditionFailed') throw error;
      const existing = await context.services.objects.send(
        new HeadObjectCommand({ Bucket: bucket, Key: `static${file.path}` }),
      );
      if (
        existing.Metadata?.['sha256'] !== file.sha256 ||
        existing.ContentLength !== file.byteLength ||
        existing.ContentType !== file.contentType
      )
        throw new Error(`immutable AWS asset path already holds different content: ${file.path}`);
    }
    files.push({
      pathname: file.path,
      blob: { sha256: file.sha256, byteLength: file.byteLength, contentType: file.contentType },
      immutable: true,
    });
  }
  const key = `static-manifests/${receipt.deploymentId}.json`;
  const body = JSON.stringify({ v: 1, files });
  try {
    await mutation('publish immutable static-file manifest', () =>
      context.services.objects.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      ),
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'PreconditionFailed') throw error;
    const existing = await context.services.objects.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (existing.Body === undefined || existing.ContentLength !== Buffer.byteLength(body))
      throw new Error('this deployment already has a different immutable static manifest');
    const held = await existing.Body.transformToString();
    if (
      createHash('sha256').update(held).digest('hex') !==
      createHash('sha256').update(body).digest('hex')
    )
      throw new Error('this deployment already has a different immutable static manifest');
  }
}

export async function deleteImage(
  context: AwsContext,
  repositoryName: string,
  imageTag: string,
): Promise<void> {
  const result = await mutation(`delete image ${imageTag}`, () =>
    context.services.ecr.send(
      new BatchDeleteImageCommand({ repositoryName, imageIds: [{ imageTag }] }),
    ),
  );
  if (result.failures?.some((failure) => failure.failureCode !== 'ImageNotFound'))
    throw new Error(`ECR could not remove image ${imageTag}`);
}
