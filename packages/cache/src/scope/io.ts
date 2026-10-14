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
  read(key: string): Promise<Uint8Array | undefined>;
  /** Whether anything is stored under the key, without reading it. */
  exists(key: string): Promise<boolean>;
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

export function blobStore(bucket: R2Bucket, faults: () => TestFaults): BlobStore {
  return {
    read: async (key) => {
      checkFault(faults, 'r2');
      const object = await bucket.get(key);
      return object === null ? undefined : new Uint8Array(await object.arrayBuffer());
    },
    exists: async (key) => {
      checkFault(faults, 'r2');
      return (await bucket.head(key)) !== null;
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
      do {
        const page = await bucket.list({
          prefix,
          limit: 1000,
          ...(cursor !== undefined && { cursor }),
        });
        if (page.objects.length > 0) {
          await bucket.delete(page.objects.map((object) => object.key));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
    },
    listPage: async ({ prefix, cursor, limit }) => {
      checkFault(faults, 'r2');
      const page = await bucket.list({ prefix, limit, ...(cursor !== undefined && { cursor }) });
      return {
        objects: page.objects.map((object) => {
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
