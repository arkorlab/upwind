import {
  type CachePolicy,
  type EntryDescriptor,
  type GenerationTag,
  type InvalidationState,
  type OutputSnapshot,
  type TagHistoryMark,
} from '@stayingupwind/core/cache';
import type { DataEntryMetadata, DataValue } from '@stayingupwind/runtime/cache-host';

import type { ObjectReference } from './objects.ts';

export interface ScopeState {
  readonly format: 1;
  readonly buildId: string;
  readonly deploymentId: string;
  readonly revision: number;
  readonly invalidationRevision: number;
  readonly invalidatedAt: number | null;
  readonly checkpoint: number;
  readonly pending: number;
  readonly status: 'seeding' | 'active' | 'retired';
}

export interface GenerationReference {
  readonly id: string;
  readonly seq: number;
  readonly revision: number;
  readonly dependencyRevision: number;
  readonly metadata: ObjectReference;
  readonly record?: ObjectReference | undefined;
}

export interface Lease {
  readonly attemptId: string;
  readonly fencingToken: number;
  readonly expiresAt: number;
  readonly dependencyRevision: number;
}

export interface EntryState {
  readonly id: string;
  readonly descriptor: EntryDescriptor;
  readonly fence: number;
  readonly seq: number;
  readonly current?: GenerationReference | undefined;
  readonly lease?: Lease | undefined;
  readonly failures: number;
  readonly retryAt: number;
}

export interface AttemptState {
  readonly entryId: string;
  readonly lease: Lease;
  readonly status: 'leased' | 'published' | 'failed';
  readonly published?: GenerationReference | undefined;
}

export interface GenerationState {
  readonly id: string;
  readonly seq: number;
  readonly source: 'build' | 'runtime';
  readonly cacheTimestamp: number | null;
  readonly producedAt: number | null;
  readonly policy: CachePolicy;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly tags: readonly GenerationTag[];
  readonly outputs: readonly OutputSnapshot[];
  readonly condemned?: InvalidationState | undefined;
  readonly data?: { readonly entry: DataEntryMetadata; readonly value: DataValue } | undefined;
}

export interface TagState {
  readonly value: string;
  readonly revision: number;
  readonly staleAt: number;
  readonly hardExpireAt: number | null;
  readonly history: readonly TagHistoryMark[];
  /** Kept separately: a folded short SWR deadline does not turn into an immediate invalidation. */
  readonly latestImmediateRevision: number;
  readonly dataHistory: readonly DataInvalidationMark[];
}

export interface DataInvalidationMark extends TagHistoryMark {
  /** Null means existing values are never spared by a worker clock ahead of the authority. */
  readonly sparedAfter: number | null;
}

export interface InvalidationEvent {
  readonly revision: number;
  readonly values: readonly string[];
  readonly staleAt: number;
  readonly hardExpireAt: number | null;
  readonly sparedAfter: number | null;
}

export interface ProjectorLease {
  readonly owner: string;
  readonly fence: number;
  readonly expiresAt: number;
}
