import type {
  CachePolicy,
  GenerationSourceKind,
  GenerationTag,
  OutputSnapshot,
} from '@stayingupwind/core/cache';

/** What a delivery record's header is made of, all of it known before the record is written. */
export interface PackHeaderFields {
  readonly scopeId: string;
  /** The immutable scope's own build, required only for version-three paired Pages output. */
  readonly buildId?: string | undefined;
  readonly packSchemaVersion?: 1 | 2 | undefined;
  readonly entry: {
    readonly entryId: string;
    readonly kind: string;
    readonly route: string | null;
    readonly pathname: string | null;
  };
  readonly generation: {
    readonly generationId: string;
    readonly seq: number;
    readonly source: GenerationSourceKind;
    readonly cacheTimestamp: number | null;
    readonly producedAt: number | null;
    readonly policy: CachePolicy;
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly tags: readonly GenerationTag[];
  };
  readonly outputs: readonly OutputSnapshot[];
}
