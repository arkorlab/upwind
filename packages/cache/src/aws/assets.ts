import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { StaticFile } from '@stayingupwind/core/bundle';

const MANIFEST_PREFIX = 'static-manifests/';
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const DIGEST = /^[a-f\d]{64}$/u;

export interface AwsAssetsOptions {
  readonly nativeRoot: string;
  readonly bundleRoot: string;
  readonly region: string;
  readonly bucket: string;
}

export function retainedStaticFiles(value: unknown): StaticFile[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('v' in value) ||
    value.v !== 1 ||
    !('files' in value) ||
    !Array.isArray(value.files)
  )
    throw new Error('invalid retained static manifest');
  return value.files.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new Error('invalid retained static file');
    const file = item as Partial<StaticFile>;
    if (
      typeof file.pathname !== 'string' ||
      !file.pathname.startsWith('/') ||
      !file.pathname.includes('/_next/static/') ||
      file.pathname.includes('?') ||
      file.pathname.includes('#') ||
      [...file.pathname].some((character) => character.charCodeAt(0) <= 32) ||
      file.pathname.split('/').some((segment) => segment === '.' || segment === '..') ||
      file.immutable !== true ||
      file.blob === undefined ||
      !DIGEST.test(file.blob.sha256) ||
      !Number.isSafeInteger(file.blob.byteLength) ||
      file.blob.byteLength < 0 ||
      typeof file.blob.contentType !== 'string'
    )
      throw new Error('retained static file is not an immutable Next.js asset');
    return { pathname: file.pathname, immutable: true, blob: { ...file.blob } };
  });
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes as Uint8Array);
  return hash.digest('hex');
}

async function manifest(client: S3Client, bucket: string, key: string): Promise<StaticFile[]> {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (
    result.Body === undefined ||
    result.ContentLength === undefined ||
    result.ContentLength > MAX_MANIFEST_BYTES
  )
    throw new Error('retained static manifest exceeds its byte limit');
  const text = await result.Body.transformToString();
  if (Buffer.byteLength(text) !== result.ContentLength)
    throw new Error('retained static manifest length differs');
  return retainedStaticFiles(JSON.parse(text));
}

async function download(
  client: S3Client,
  options: AwsAssetsOptions,
  file: StaticFile,
): Promise<void> {
  const destination = path.join(options.bundleRoot, 'blobs', file.blob.sha256);
  try {
    const found = await stat(destination);
    if (
      found.isFile() &&
      found.size === file.blob.byteLength &&
      (await fileDigest(destination)) === file.blob.sha256
    )
      return;
    throw new Error('the retained static blob differs from its digest');
  } catch (error) {
    if (
      !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
    )
      throw error;
  }
  const response = await client.send(
    new GetObjectCommand({ Bucket: options.bucket, Key: `static${file.pathname}` }),
  );
  if (response.Body === undefined || response.ContentLength !== file.blob.byteLength)
    throw new Error('retained static asset length differs');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  const reader = response.Body.transformToWebStream().getReader();
  const hash = createHash('sha256');
  let received = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > file.blob.byteLength)
        throw new Error('retained static asset exceeded its byte limit');
      hash.update(chunk.value);
      await handle.writeFile(chunk.value);
    }
    if (received !== file.blob.byteLength || hash.digest('hex') !== file.blob.sha256)
      throw new Error('retained static asset digest differs');
    await handle.close();
    await rename(temporary, destination);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Hydrate before readiness, so old assets still go through the ordinary native router and headers. */
export async function prepareAwsAssets(options: AwsAssetsOptions): Promise<void> {
  if (
    !path.isAbsolute(options.bundleRoot) ||
    options.bundleRoot === options.nativeRoot ||
    !options.bundleRoot.startsWith('/tmp/upwind-bundle/')
  )
    throw new Error('AWS bundle root must be a private /tmp/upwind-bundle directory');
  const raw = JSON.parse(await readFile(path.join(options.nativeRoot, 'runtime.json'), 'utf8')) as {
    staticFiles: StaticFile[];
  };
  const current = new Map(raw.staticFiles.map((file) => [file.pathname, file]));
  const retained = new Map<string, StaticFile>();
  const client = new S3Client({ region: options.region });
  try {
    let cursor: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: options.bucket,
          Prefix: MANIFEST_PREFIX,
          ...(cursor === undefined ? {} : { ContinuationToken: cursor }),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key === undefined || !object.Key.endsWith('.json')) continue;
        for (const file of await manifest(client, options.bucket, object.Key)) {
          const old = retained.get(file.pathname);
          if (old !== undefined && old.blob.sha256 !== file.blob.sha256)
            throw new Error('retained immutable assets reuse a pathname for different bytes');
          retained.set(file.pathname, file);
        }
      }
      cursor = page.NextContinuationToken;
    } while (cursor !== undefined);
    await mkdir(path.join(options.bundleRoot, 'blobs'), { recursive: true });
    for (const digest of await readdir(path.join(options.nativeRoot, 'blobs'))) {
      if (!DIGEST.test(digest)) continue;
      try {
        await symlink(
          path.join(options.nativeRoot, 'blobs', digest),
          path.join(options.bundleRoot, 'blobs', digest),
        );
      } catch (error) {
        if (
          !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'EEXIST'
          )
        )
          throw error;
      }
    }
    for (const file of retained.values()) {
      const active = current.get(file.pathname);
      if (active !== undefined) {
        if (active.blob.sha256 !== file.blob.sha256)
          throw new Error('immutable static pathname changed between deployments');
        continue;
      }
      await download(client, options, file);
      current.set(file.pathname, file);
    }
    await writeFile(
      path.join(options.bundleRoot, 'runtime.json'),
      JSON.stringify({ ...raw, staticFiles: [...current.values()] }),
    );
  } finally {
    client.destroy();
  }
}
