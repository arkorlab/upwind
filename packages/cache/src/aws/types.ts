import type { ScopeRevision } from '@stayingupwind/core/paas';
import type { CacheHostBinding } from '@stayingupwind/runtime/cache-host';

import type { NativeCacheSeed } from '../native/protocol.ts';

export interface AwsCacheOptions {
  readonly scopeId: string;
  readonly buildId: string;
  readonly deploymentId: string;
  readonly backend: 'valkey' | 'dynamodb';
  readonly region: string;
  readonly bucket: string;
  readonly table?: string | undefined;
  readonly valkeyUrl?: string | undefined;
  readonly valkeyUsername?: string | undefined;
  readonly valkeyPassword?: string | undefined;
  readonly seed?: NativeCacheSeed | undefined;
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

export interface AwsCache {
  readonly binding: CacheHostBinding;
  readScopeRevision(): Promise<ScopeRevision>;
  close(): Promise<void>;
}

export interface Stored<T = unknown> {
  readonly raw: string;
  readonly value: T;
}

export interface StorePage {
  readonly items: readonly { readonly key: string; readonly stored: Stored }[];
  readonly cursor?: string | undefined;
}

/** All keys of one authority belong to one scope and one Valkey hash slot. */
export interface AuthorityStore {
  readonly kind: 'valkey' | 'dynamodb';
  now(): Promise<number>;
  read<T>(key: string, signal?: AbortSignal): Promise<Stored<T> | undefined>;
  readMany(keys: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, Stored>>;
  list(prefix: string, after?: string, limit?: number): Promise<StorePage>;
  /** Compare every expected value and publish every write atomically. Null means absent/delete. */
  change(
    expected: ReadonlyMap<string, string | null>,
    writes: ReadonlyMap<string, unknown | null>,
    notAfter?: number,
    expires?: ReadonlyMap<string, number>,
  ): Promise<boolean>;
  sweepExpired(): Promise<void>;
  close(): Promise<void>;
}

export function stored<T>(raw: string): Stored<T> {
  return { raw, value: JSON.parse(raw) as T };
}

export const SCOPE_KEY = 'scope';
export const PROJECTOR_KEY = 'projector';
export const MAX_PENDING_EVENTS = 8;
export const MAX_CHANGE_TRIES = 32;
export const PAGE_TAGS = 500;
export const LEASE_MS = 30_000;
export const PROJECTOR_LEASE_MS = 30_000;
/** Leave room to take over an abandoned projector lease and publish its next checkpoint. */
export const INVALIDATION_BACKPRESSURE_MS = PROJECTOR_LEASE_MS * 2;
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
/** Match the native authority's completed-attempt and per-writer grace window. */
export const TRANSIENT_RETENTION_MS = 3_600_000;

export function revisionKey(prefix: string, revision: number): string {
  return `${prefix}${String(revision).padStart(16, '0')}`;
}
