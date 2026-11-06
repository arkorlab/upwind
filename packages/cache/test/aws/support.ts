import { createHash, randomUUID } from 'node:crypto';

import { AwsAuthority } from '../../src/aws/authority.ts';
import type { ObjectReference, ObjectStore } from '../../src/aws/objects.ts';
import {
  type AuthorityStore,
  type AwsCacheOptions,
  type Stored,
  stored,
  type StorePage,
} from '../../src/aws/types.ts';

export class MemoryAuthorityStore implements AuthorityStore {
  readonly kind: 'valkey' | 'dynamodb';
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, number>();
  clockOffset = 0;
  afterChange?: ((keys: readonly string[]) => Promise<void>) | undefined;
  maximumTransaction = 0;

  constructor(kind: 'valkey' | 'dynamodb') {
    this.kind = kind;
  }
  now(): Promise<number> {
    return Promise.resolve(Date.now() + this.clockOffset);
  }
  #expire(key: string): void {
    const until = this.expirations.get(key);
    if (until !== undefined && until <= Date.now() + this.clockOffset) {
      this.values.delete(key);
      this.expirations.delete(key);
    }
  }
  read<T>(key: string): Promise<Stored<T> | undefined> {
    this.#expire(key);
    const raw = this.values.get(key);
    return Promise.resolve(raw === undefined ? undefined : stored<T>(raw));
  }
  readMany(keys: readonly string[]): Promise<ReadonlyMap<string, Stored>> {
    const values = new Map<string, Stored>();
    for (const key of keys) {
      this.#expire(key);
      const raw = this.values.get(key);
      if (raw !== undefined) values.set(key, stored(raw));
    }
    return Promise.resolve(values);
  }
  list(prefix: string, after?: string, limit = 100): Promise<StorePage> {
    for (const key of this.expirations.keys()) this.#expire(key);
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort();
    const selected = keys.slice(0, limit);
    return Promise.resolve({
      items: selected.map((key) => ({ key, stored: stored(this.values.get(key) ?? '') })),
      ...(keys.length > limit ? { cursor: selected.at(-1) } : {}),
    });
  }
  async change(
    expected: ReadonlyMap<string, string | null>,
    writes: ReadonlyMap<string, unknown | null>,
    notAfter?: number,
    expires: ReadonlyMap<string, number> = new Map(),
  ): Promise<boolean> {
    const count = new Set([...expected.keys(), ...writes.keys()]).size;
    this.maximumTransaction = Math.max(this.maximumTransaction, count);
    if (this.kind === 'dynamodb' && count > 100) throw new Error('transaction exceeded 100 items');
    if (notAfter !== undefined && notAfter <= Date.now()) return false;
    for (const key of expected.keys()) this.#expire(key);
    for (const [key, previous] of expected)
      if ((this.values.get(key) ?? null) !== previous) return false;
    for (const [key, value] of writes) {
      if (value === null) this.values.delete(key);
      else this.values.set(key, JSON.stringify(value));
      const until = expires.get(key);
      if (until === undefined || value === null) this.expirations.delete(key);
      else this.expirations.set(key, until);
    }
    await this.afterChange?.([...writes.keys()]);
    return true;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  sweepExpired(): Promise<void> {
    for (const key of this.expirations.keys()) this.#expire(key);
    return Promise.resolve();
  }
}

export class MemoryObjects implements ObjectStore {
  readonly values = new Map<string, Uint8Array>();
  failWrites = false;
  readonly directory = new Map<string, ObjectReference>();
  link(artifactId: string, ref: ObjectReference): Promise<void> {
    this.directory.set(artifactId, ref);
    return Promise.resolve();
  }
  lookup(artifactId: string): Promise<ObjectReference | undefined> {
    return Promise.resolve(this.directory.get(artifactId));
  }
  put(bytes: Uint8Array, category: string): Promise<ObjectReference> {
    if (this.failWrites) return Promise.reject(new Error('object upload failed'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `${category}/${sha256}`;
    this.values.set(key, bytes.slice());
    return Promise.resolve({ key, sha256, byteLength: bytes.byteLength });
  }
  read(ref: ObjectReference): Promise<Uint8Array> {
    const value = this.values.get(ref.key);
    if (value === undefined) return Promise.reject(new Error('object missing'));
    return Promise.resolve(value.slice());
  }
  clear(): Promise<void> {
    this.values.clear();
    this.directory.clear();
    return Promise.resolve();
  }
  close(): void {
    /* fixtures share the store between independently owned application tasks */
  }
}

export function options(
  kind: 'valkey' | 'dynamodb',
  scopeId = `scope_${randomUUID()}`,
): AwsCacheOptions {
  return {
    backend: kind,
    scopeId,
    deploymentId: scopeId,
    buildId: 'build-id',
    region: 'us-east-1',
    bucket: 'test-bucket',
  };
}

export async function pair(
  store: AuthorityStore,
  opts = options(store.kind),
  objects = new MemoryObjects(),
) {
  const first = new AwsAuthority(opts, store, objects);
  const second = new AwsAuthority(opts, store, objects);
  await first.initialize();
  await second.initialize();
  return {
    first,
    second,
    objects,
    close: async () => {
      await first.close();
      await second.close();
    },
  };
}
