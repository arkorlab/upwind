import { createHash } from 'node:crypto';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { MAX_ARTIFACT_BYTES } from './types.ts';

export interface ObjectReference {
  readonly key: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ObjectStore {
  put(bytes: Uint8Array, category: string, contentType?: string): Promise<ObjectReference>;
  read(ref: ObjectReference, signal?: AbortSignal): Promise<Uint8Array>;
  link(artifactId: string, ref: ObjectReference): Promise<void>;
  lookup(artifactId: string): Promise<ObjectReference | undefined>;
  clear(): Promise<void>;
  close(): void;
}

export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function boundedBody(
  body: { transformToWebStream(): ReadableStream<Uint8Array> },
  length: number,
  external?: AbortSignal,
): Promise<Uint8Array> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(external === undefined ? [] : [external]),
  ]);
  const reader = body.transformToWebStream().getReader();
  const abort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const bytes = new Uint8Array(length);
  let offset = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) break;
      if (offset + result.value.byteLength > bytes.byteLength)
        throw new Error('AWS cache object exceeded its reference');
      bytes.set(result.value, offset);
      offset += result.value.byteLength;
    }
    if (offset !== length) throw new Error('AWS cache object ended before its declared length');
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function statusOf(error: Error): unknown {
  const metadata: unknown = Reflect.get(error, '$metadata');
  return typeof metadata === 'object' && metadata !== null
    ? Reflect.get(metadata, 'httpStatusCode')
    : undefined;
}

/** Only immutable, scope-confined keys are ever written; publication is the metadata CAS. */
export class S3Objects implements ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;

  constructor(region: string, bucket: string, scopeId: string) {
    this.#client = new S3Client({
      region,
      maxAttempts: 3,
      requestHandler: {
        connectionTimeout: 1000,
        requestTimeout: 10_000,
        throwOnRequestTimeout: true,
      },
    });
    this.#bucket = bucket;
    this.#prefix = `aws-cache/${scopeId}/`;
  }

  async put(
    bytes: Uint8Array,
    category: string,
    contentType = 'application/octet-stream',
  ): Promise<ObjectReference> {
    if (bytes.byteLength > MAX_ARTIFACT_BYTES)
      throw new Error('AWS cache object exceeds its byte limit');
    if (!/^[a-z-]+$/u.test(category)) throw new Error('invalid AWS cache object category');
    const sha256 = digest(bytes);
    const key = `${this.#prefix}${category}/${sha256}`;
    await this.#put(bytes, key, contentType);
    return { key, sha256, byteLength: bytes.byteLength };
  }

  async #put(bytes: Uint8Array, key: string, contentType: string): Promise<void> {
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          IfNoneMatch: '*',
          ChecksumSHA256: Buffer.from(digest(bytes), 'hex').toString('base64'),
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (error.name !== 'PreconditionFailed' && statusOf(error) !== 412)
      )
        throw error;
    }
  }

  #artifactKey(artifactId: string): string {
    if (!/^[\w+~-]{1,256}$/u.test(artifactId))
      throw new Error('invalid AWS cache artifact identity');
    return `${this.#prefix}artifacts/${artifactId}`;
  }

  /** The permanent directory lets the hot metadata index expire without losing a current blob. */
  async link(artifactId: string, ref: ObjectReference): Promise<void> {
    await this.#put(
      new TextEncoder().encode(JSON.stringify(ref)),
      this.#artifactKey(artifactId),
      'application/json',
    );
  }

  async lookup(artifactId: string): Promise<ObjectReference | undefined> {
    try {
      const answer = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: this.#artifactKey(artifactId) }),
      );
      if (
        answer.Body === undefined ||
        answer.ContentLength === undefined ||
        answer.ContentLength > 2048
      )
        throw new Error('invalid AWS cache artifact directory record');
      const bytes = await boundedBody(answer.Body, answer.ContentLength);
      return JSON.parse(new TextDecoder().decode(bytes)) as ObjectReference;
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchKey') return undefined;
      throw error;
    }
  }

  async read(ref: ObjectReference, signal?: AbortSignal): Promise<Uint8Array> {
    if (
      !ref.key.startsWith(this.#prefix) ||
      !/^[a-f\d]{64}$/u.test(ref.sha256) ||
      !Number.isSafeInteger(ref.byteLength) ||
      ref.byteLength < 0 ||
      ref.byteLength > MAX_ARTIFACT_BYTES
    )
      throw new Error('invalid AWS cache object reference');
    const response = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: ref.key,
      }),
      signal === undefined ? {} : { abortSignal: signal },
    );
    if (response.ContentLength !== ref.byteLength || response.Body === undefined) {
      try {
        await response.Body?.transformToWebStream().cancel();
      } catch {
        // Best-effort disposal must preserve the authoritative length mismatch below.
      }
      throw new Error('AWS cache object length differs from its reference');
    }
    const bytes = await boundedBody(response.Body, ref.byteLength, signal);
    if (digest(bytes) !== ref.sha256)
      throw new Error('AWS cache object digest differs from its reference');
    return bytes;
  }

  close(): void {
    this.#client.destroy();
  }

  /** Called only by the retirement task, after every application task has drained. */
  async clear(): Promise<void> {
    let continuation: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: this.#prefix,
          ...(continuation === undefined ? {} : { ContinuationToken: continuation }),
        }),
      );
      const keys = (page.Contents ?? []).flatMap((item) =>
        item.Key === undefined ? [] : [{ Key: item.Key }],
      );
      if (keys.length > 0) {
        const answer = await this.#client.send(
          new DeleteObjectsCommand({
            Bucket: this.#bucket,
            Delete: { Objects: keys, Quiet: true },
          }),
        );
        if ((answer.Errors?.length ?? 0) > 0)
          throw new Error('AWS cache scope objects could not all be retired');
      }
      continuation = page.NextContinuationToken;
      if (page.IsTruncated === true && continuation === undefined)
        throw new Error('AWS cache retirement listing omitted its continuation');
    } while (continuation !== undefined);
  }
}
