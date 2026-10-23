import { releaseStream, withDeadline } from '@stayingupwind/core/util';

import {
  copyRepairBlob,
  type RepairBlobLocation,
  type RepairCopyOwner,
  repairUploadMatches,
  type RepairUploadProof,
} from './repair-upload.ts';

/**
 * What the authority writes to after a commit, behind interfaces narrow enough to fake, and the
 * faults a test may inject into them — into a host's history's own as well (`history`), and into
 * the alarm the authority arms to come back for what they refused. A fault is read at the time of
 * each call, so one turned on after a commit fails the settle that follows and one turned off lets
 * the alarm's retry succeed.
 */

export interface TestFaults {
  readonly kv?: boolean;
  readonly r2?: boolean;
  readonly history?: boolean;
  readonly alarm?: boolean;
}

export interface KvSink {
  put(key: string, value: string | Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  listPage(input: {
    readonly prefix: string;
    readonly cursor: string | undefined;
    readonly limit: number;
  }): Promise<{ readonly keys: readonly string[]; readonly cursor: string | undefined }>;
}

export interface BlobStore {
  /** Read only the declared length, using the metadata returned by the same storage GET. */
  read(key: string, byteLength: number): Promise<Uint8Array | undefined>;
  /** Whether anything is stored under the key, without reading it. */
  exists(key: string): Promise<boolean>;
  /** Fresh version-two repairs replace that same HEAD with a checksum and ownership check. */
  verifiedRepair?(key: string, proof: RepairUploadProof): Promise<boolean>;
  /** Rare seed/data repairs copy to fixed-width locations without buffering a large body. */
  copyRepair?(location: RepairBlobLocation, owner: RepairCopyOwner): Promise<string | undefined>;
  write(key: string, value: string | Uint8Array, contentType: string): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  /** Delete a retired scope's remaining keys without retaining its whole keyspace in memory. */
  deletePrefix(prefix: string): Promise<void>;
  /** A bounded page for active-scope sweeps, including objects no transaction ever recorded. */
  listPage(input: {
    readonly prefix: string;
    readonly cursor: string | undefined;
    readonly limit: number;
  }): Promise<{
    readonly objects: readonly { readonly key: string; readonly uploadedAt: number }[];
    readonly cursor: string | undefined;
  }>;
}

/**
 * A data value's bytes as its write handed them over with it, by the name the gateway gave them as
 * it stored them (`DataSetInput.bytes`): what the write's settle makes the value's record of, in
 * place of a read of the store they were stored in.
 */
export interface CarriedValue {
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

const HEX_RADIX = 16;

/** A stored body differs from its declared size, before any of its bytes are materialized. */
export class BlobLengthError extends Error {
  override name = 'BlobLengthError';

  readonly byteLength: number;

  constructor(byteLength: number, expected: number, options?: ErrorOptions) {
    super(`stored blob has ${byteLength} bytes, not ${expected}`, options);
    this.byteLength = byteLength;
  }
}

class InjectedFaultError extends Error {
  constructor(target: string, options?: ErrorOptions) {
    super(`injected ${target} fault`, options);
    this.name = 'InjectedFaultError';
  }
}

export function checkFault(faults: () => TestFaults, target: keyof TestFaults): void {
  if (faults()[target] === true) {
    throw new InjectedFaultError(target);
  }
}

/** Verify a proposed shared location without retaining the artifact's body in memory. */
export async function verifyBlob(
  open: (key: string) => Promise<Pick<R2ObjectBody, 'size' | 'body'> | null>,
  location: { readonly storageRef: string; readonly byteLength: number; readonly sha256: string },
  signal: AbortSignal,
): Promise<boolean> {
  const object = await open(location.storageRef);
  if (object === null) return false;
  if (signal.aborted || object.size !== location.byteLength) {
    releaseStream(object.body);
    signal.throwIfAborted();
    return false;
  }
  const { hash, byteLength } = await digestBody(object.body, signal);
  const hex = [...new Uint8Array(hash)]
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, '0'))
    .join('');
  return byteLength === location.byteLength && hex === location.sha256;
}

async function digestBody(body: ReadableStream<unknown>, signal: AbortSignal) {
  const reader = body.getReader();
  const digest = new crypto.DigestStream('SHA-256');
  const writer = digest.getWriter();
  const stop = (): void => {
    releaseStream(reader);
    void writer.abort(signal.reason).catch(() => {
      /* A closed digest has nothing left to abort. */
    });
  };
  signal.addEventListener('abort', stop, { once: true });
  const copy = async (): Promise<void> => {
    try {
      for (;;) {
        const item = await reader.read();
        signal.throwIfAborted();
        if (item.done) break;
        if (!(item.value instanceof Uint8Array)) throw new TypeError('artifact body is not bytes');
        await writer.write(item.value);
      }
      await writer.close();
    } catch (error) {
      stop();
      throw error;
    } finally {
      signal.removeEventListener('abort', stop);
      reader.releaseLock();
      writer.releaseLock();
    }
  };
  const [, hash] = await Promise.all([copy(), digest.digest]);
  return { hash, byteLength: Number(digest.bytesWritten) };
}

export function kvSink(kv: KVNamespace, faults: () => TestFaults): KvSink {
  return {
    put: async (key, value) => {
      checkFault(faults, 'kv');
      await kv.put(key, typeof value === 'string' ? value : (value as BufferSource));
    },
    delete: async (key) => {
      checkFault(faults, 'kv');
      await kv.delete(key);
    },
    listPage: async ({ prefix, cursor, limit }) => {
      checkFault(faults, 'kv');
      const page = await kv.list({ prefix, limit, ...(cursor !== undefined && { cursor }) });
      return {
        keys: page.keys.map((key) => key.name),
        cursor: page.list_complete ? undefined : page.cursor,
      };
    },
  };
}

/** How soon KV takes a second write of a key: one within a second it refuses (429). */
const KEY_WRITE_INTERVAL_MS = 1000;
/** How KV says it refused a write for the key's second (`… 429 Too Many Requests`). */
const RATE_LIMITED = /\b429\b/u;

/**
 * Make a write of one KV key, and make it once more a second later where KV refused it for the
 * key's second (429): a record a change rewrites just after the one before it went out — an
 * invalidation's of a commit's, a tag's of the run before — is written again within one. Any other
 * failure, or a second refusal, is the write's. Nothing is kept of earlier writes, which an object's
 * restart would lose, and the wait is the caller's, over when it is.
 */
export async function writeKey(write: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await write();
      return;
    } catch (error) {
      if (attempt > 1 || !(error instanceof Error) || !RATE_LIMITED.test(error.message)) {
        throw error;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, KEY_WRITE_INTERVAL_MS);
    });
  }
}

/**
 * How long a stored body may take to arrive once its object has answered: the ten seconds the
 * artifact gateway gives a read of one (`seed-repair.ts` holds a verification to the same).
 */
const BLOB_READ_MS = 10_000;

/**
 * A stored body's bytes, read no further than its declared length and no longer than `readMs`. A
 * body that stalls is cancelled when the time is up, and the read fails as any read of storage
 * may: what awaits it — a delivery record's projection, which every later settle of the scope
 * waits behind — fails into the retry its alarm makes, rather than waiting on a body that never
 * comes (Codex).
 */
async function bodyWithin(
  object: R2ObjectBody,
  byteLength: number,
  readMs: number,
): Promise<Uint8Array> {
  const reader = object.body.getReader();
  const bytes = new Uint8Array(byteLength);
  let read = 0;
  const reading = async (): Promise<Uint8Array> => {
    for (;;) {
      const item: ReadableStreamReadResult<unknown> = await reader.read();
      if (item.done) break;
      const chunk = item.value;
      if (!(chunk instanceof Uint8Array)) throw new TypeError('a stored body is not bytes');
      if (read + chunk.byteLength > byteLength) {
        throw new BlobLengthError(read + chunk.byteLength, byteLength);
      }
      bytes.set(chunk, read);
      read += chunk.byteLength;
    }
    if (read !== byteLength) {
      throw new BlobLengthError(read, byteLength);
    }
    return bytes;
  };
  try {
    return await withDeadline(reading(), readMs, 'a stored blob read');
  } catch (error) {
    // Nothing more of it is wanted: the body is given back, whatever is still on its way.
    releaseStream(reader);
    throw error;
  }
}

/** A repair prefix is scoped independently from legacy user-controlled literal keys. */
function repairPrefixNamespace(prefix: string): string | undefined {
  return /^r\/([0-9a-f]{32})\/$/u.exec(prefix)?.[1];
}

/** A matching prefix alone never authorizes deletion of an unrelated object. */
function ownedRepairObject(
  object: R2Object,
  namespace: string,
  repairOwner: string | undefined,
): boolean {
  return (
    /^r\/[0-9a-f]{32}\/[0-9a-f]{32}$/u.test(object.key) &&
    object.key.startsWith(`r/${namespace}/`) &&
    repairOwner !== undefined &&
    object.customMetadata?.upwindRepair === '1' &&
    object.customMetadata.upwindRepairOwner === repairOwner &&
    object.customMetadata.upwindRepairNamespace === namespace &&
    typeof object.customMetadata.upwindRepairAttempt === 'string'
  );
}

export function blobStore(
  bucket: R2Bucket,
  faults: () => TestFaults,
  options: { readonly readMs?: number; readonly repairOwner?: string | undefined } = {},
): BlobStore {
  const readMs = options.readMs ?? BLOB_READ_MS;
  return {
    read: async (key, byteLength) => {
      checkFault(faults, 'r2');
      const object = await bucket.get(key);
      if (object === null) return;
      if (object.size !== byteLength) {
        releaseStream(object.body);
        throw new BlobLengthError(object.size, byteLength);
      }
      return bodyWithin(object, byteLength, readMs);
    },
    exists: async (key) => {
      checkFault(faults, 'r2');
      return (await bucket.head(key)) !== null;
    },
    verifiedRepair: async (key, proof) => {
      if (!key.startsWith(`r/${proof.namespace}/`)) return false;
      checkFault(faults, 'r2');
      return repairUploadMatches(await bucket.head(key), {
        ...proof,
        scopeOwner: options.repairOwner,
      });
    },
    copyRepair: async (location, owner) => {
      checkFault(faults, 'r2');
      const controller = new AbortController();
      try {
        return await withDeadline(
          copyRepairBlob(
            bucket,
            location,
            { ...owner, scopeOwner: options.repairOwner },
            controller.signal,
          ),
          readMs,
          'a repair blob copy',
        );
      } finally {
        controller.abort();
      }
    },
    write: async (key, value, contentType) => {
      checkFault(faults, 'r2');
      await bucket.put(key, typeof value === 'string' ? value : (value as BufferSource), {
        httpMetadata: { contentType },
      });
    },
    delete: async (keys) => {
      checkFault(faults, 'r2');
      const batchLimit = 1000;
      for (let offset = 0; offset < keys.length; offset += batchLimit) {
        await bucket.delete(keys.slice(offset, offset + batchLimit));
      }
    },
    deletePrefix: async (prefix) => {
      checkFault(faults, 'r2');
      let cursor: string | undefined;
      const namespace = repairPrefixNamespace(prefix);
      do {
        const page = await bucket.list({
          prefix,
          limit: 1000,
          ...(namespace !== undefined && { include: ['customMetadata' as const] }),
          ...(cursor !== undefined && { cursor }),
        });
        const objects =
          namespace === undefined
            ? page.objects
            : page.objects.filter((object) =>
                ownedRepairObject(object, namespace, options.repairOwner),
              );
        if (objects.length > 0) {
          await bucket.delete(objects.map((object) => object.key));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
    },
    listPage: async ({ prefix, cursor, limit }) => {
      checkFault(faults, 'r2');
      const namespace = repairPrefixNamespace(prefix);
      const page = await bucket.list({
        prefix,
        limit,
        ...(namespace !== undefined && { include: ['customMetadata' as const] }),
        ...(cursor !== undefined && { cursor }),
      });
      const objects =
        namespace === undefined
          ? page.objects
          : page.objects.filter((object) =>
              ownedRepairObject(object, namespace, options.repairOwner),
            );
      return {
        objects: objects.map((object) => {
          return {
            key: object.key,
            uploadedAt: object.uploaded.getTime(),
          };
        }),
        cursor: page.truncated ? page.cursor : undefined,
      };
    },
  };
}
