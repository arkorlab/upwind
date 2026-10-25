import type { SeedEntryInput } from '@stayingupwind/host/cache';

/** Only immutable build-owned data crosses this boundary; callbacks stay in the server. */
export interface NativeCacheSeed {
  readonly entries: readonly SeedEntryInput[];
  readonly blobsDirectory: string;
}

export interface NativeCacheOptions {
  readonly directory: string;
  readonly scopeId: string;
  readonly buildId: string;
  readonly deploymentId?: string | undefined;
  readonly workerUrl?: { readonly href: string } | undefined;
  readonly seed?: NativeCacheSeed | undefined;
}

export type NativeCacheWorkerOptions = Omit<NativeCacheOptions, 'workerUrl'>;

export interface CacheCall {
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

export type CacheAnswer =
  | { readonly id: number; readonly value: unknown }
  | { readonly id: number; readonly error: { readonly message: string; readonly code?: string } };
