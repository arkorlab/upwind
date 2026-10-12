import { MAX_PACK_BYTES } from '@stayingupwind/core/cache';
import { z } from 'zod';

/** A number, as `wrangler.jsonc` carries one, or its text, as `.dev.vars` does; or none at all. */
type Setting = number | string | undefined;

/**
 * The settings the cache reads from its environment (`parseVars`): a scope's ceilings and
 * lifetimes, as numbers or their text — each left out is `DEFAULT_CACHE_VARS`' — the keys its
 * tokens are signed with, and the switch that turns on the test clock header and fault injection,
 * which only a test configuration carries.
 */
export interface CacheVars {
  readonly QUOTA_ENTRIES_PER_SCOPE?: Setting;
  readonly QUOTA_ATTEMPTS_PER_MINUTE?: Setting;
  readonly QUOTA_BODY_BYTES_PER_SCOPE?: Setting;
  readonly QUOTA_TAGS_PER_SCOPE?: Setting;
  readonly MAX_ARTIFACT_BYTES?: Setting;
  readonly LEASE_SECONDS?: Setting;
  readonly RETAIN_NONCURRENT_DAYS?: Setting;
  readonly RETAIN_NONCURRENT_GENERATIONS?: Setting;
  readonly RETAIN_HISTORY_DAYS?: Setting;
  readonly RETAIN_NONCURRENT_UNRECORDED_HOURS?: Setting;
  readonly RETAIN_HISTORY_UNRECORDED_HOURS?: Setting;
  readonly CACHE_TOKEN_KEY?: string | undefined;
  readonly CACHE_TOKEN_KEY_PREVIOUS?: string | undefined;
  readonly ARKOR_TEST_HOOKS?: string | undefined;
}

/**
 * The ceilings and lifetimes a scope is held to where its host's environment names none: the
 * per-scope protection the authority always applies, at the values a deployment of the cache states
 * unless it states others.
 */
export const DEFAULT_CACHE_VARS = {
  QUOTA_ENTRIES_PER_SCOPE: 50_000,
  QUOTA_ATTEMPTS_PER_MINUTE: 600,
  QUOTA_BODY_BYTES_PER_SCOPE: 2_147_483_648,
  QUOTA_TAGS_PER_SCOPE: 100_000,
  MAX_ARTIFACT_BYTES: 26_214_400,
  LEASE_SECONDS: 60,
  RETAIN_NONCURRENT_DAYS: 7,
  RETAIN_NONCURRENT_GENERATIONS: 20,
  RETAIN_HISTORY_DAYS: 30,
  RETAIN_NONCURRENT_UNRECORDED_HOURS: 1,
  RETAIN_HISTORY_UNRECORDED_HOURS: 24,
} as const;

/** As long as a signing key has to be: a token is what lets a Worker write a scope. */
const MIN_KEY_LENGTH = 32;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
/**
 * How long one settle run keeps rewriting delivery records (`settle.ts`): the first chunk always,
 * and no chunk begun once this much has passed since the run began, or while another run waits.
 * A large invalidation is answered after its first slice and the alarm takes up the rest a slice
 * at a time, so a change arriving behind it waits for a chunk of that rewrite and the bookkeeping
 * of the run in hand, not for all of it.
 */
const PROJECTION_SLICE_MS = 100;

/** A setting that may be left out, or left empty in `.dev.vars`, which reads back as `''`. */
const optionalKey = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()))
  .pipe(z.string().min(MIN_KEY_LENGTH).optional());

/** `wrangler.jsonc` carries numbers; `.dev.vars` carries their text. */
const positiveInt = z.coerce.number().int().positive();

const varsSchema = z.object({
  QUOTA_ENTRIES_PER_SCOPE: positiveInt,
  QUOTA_ATTEMPTS_PER_MINUTE: positiveInt,
  QUOTA_BODY_BYTES_PER_SCOPE: positiveInt,
  QUOTA_TAGS_PER_SCOPE: positiveInt,
  MAX_ARTIFACT_BYTES: positiveInt,
  LEASE_SECONDS: positiveInt,
  RETAIN_NONCURRENT_DAYS: positiveInt,
  RETAIN_NONCURRENT_GENERATIONS: positiveInt,
  RETAIN_HISTORY_DAYS: positiveInt,
  RETAIN_NONCURRENT_UNRECORDED_HOURS: positiveInt,
  RETAIN_HISTORY_UNRECORDED_HOURS: positiveInt,
  CACHE_TOKEN_KEY: optionalKey,
  CACHE_TOKEN_KEY_PREVIOUS: optionalKey,
  ARKOR_TEST_HOOKS: z
    .string()
    .optional()
    .transform((value) => value === '1'),
});

export type Vars = z.infer<typeof varsSchema>;

const cache = new WeakMap<CacheVars, Vars>();

/** Validate configuration once per isolate (the same `env` object is reused across requests). */
export function parseVars(env: CacheVars): Vars {
  const cached = cache.get(env);
  if (cached !== undefined) {
    return cached;
  }
  const vars = varsSchema.parse({
    QUOTA_ENTRIES_PER_SCOPE:
      env.QUOTA_ENTRIES_PER_SCOPE ?? DEFAULT_CACHE_VARS.QUOTA_ENTRIES_PER_SCOPE,
    QUOTA_ATTEMPTS_PER_MINUTE:
      env.QUOTA_ATTEMPTS_PER_MINUTE ?? DEFAULT_CACHE_VARS.QUOTA_ATTEMPTS_PER_MINUTE,
    QUOTA_BODY_BYTES_PER_SCOPE:
      env.QUOTA_BODY_BYTES_PER_SCOPE ?? DEFAULT_CACHE_VARS.QUOTA_BODY_BYTES_PER_SCOPE,
    QUOTA_TAGS_PER_SCOPE: env.QUOTA_TAGS_PER_SCOPE ?? DEFAULT_CACHE_VARS.QUOTA_TAGS_PER_SCOPE,
    MAX_ARTIFACT_BYTES: env.MAX_ARTIFACT_BYTES ?? DEFAULT_CACHE_VARS.MAX_ARTIFACT_BYTES,
    LEASE_SECONDS: env.LEASE_SECONDS ?? DEFAULT_CACHE_VARS.LEASE_SECONDS,
    RETAIN_NONCURRENT_DAYS: env.RETAIN_NONCURRENT_DAYS ?? DEFAULT_CACHE_VARS.RETAIN_NONCURRENT_DAYS,
    RETAIN_NONCURRENT_GENERATIONS:
      env.RETAIN_NONCURRENT_GENERATIONS ?? DEFAULT_CACHE_VARS.RETAIN_NONCURRENT_GENERATIONS,
    RETAIN_HISTORY_DAYS: env.RETAIN_HISTORY_DAYS ?? DEFAULT_CACHE_VARS.RETAIN_HISTORY_DAYS,
    RETAIN_NONCURRENT_UNRECORDED_HOURS:
      env.RETAIN_NONCURRENT_UNRECORDED_HOURS ??
      DEFAULT_CACHE_VARS.RETAIN_NONCURRENT_UNRECORDED_HOURS,
    RETAIN_HISTORY_UNRECORDED_HOURS:
      env.RETAIN_HISTORY_UNRECORDED_HOURS ?? DEFAULT_CACHE_VARS.RETAIN_HISTORY_UNRECORDED_HOURS,
    CACHE_TOKEN_KEY: env.CACHE_TOKEN_KEY,
    CACHE_TOKEN_KEY_PREVIOUS: env.CACHE_TOKEN_KEY_PREVIOUS,
    ARKOR_TEST_HOOKS: env.ARKOR_TEST_HOOKS,
  });
  cache.set(env, vars);
  return vars;
}

/** The ceilings and lifetimes a scope's authority applies, in the units its clock uses. */
export interface ScopeLimits {
  readonly entriesPerScope: number;
  readonly attemptsPerMinute: number;
  readonly bodyBytesPerScope: number;
  /**
   * How many distinct tags the scope keeps a row for. A tag is remembered for good once it is
   * invalidated, so an application that names a fresh one each time would grow the scope without end.
   */
  readonly tagsPerScope: number;
  readonly maxArtifactBytes: number;
  /** As large as a delivery record may be: one KV value, which is not a deployment's to choose. */
  readonly maxRecordBytes: number;
  readonly leaseMs: number;
  readonly retainNoncurrentMs: number;
  readonly retainNoncurrentGenerations: number;
  /** How long a retired scope is kept, and a recording scope's history (`retention.ts`). */
  readonly retainHistoryMs: number;
  /**
   * The same two for a scope whose history is not kept (`ScopeHistory.keeps`), which nothing will
   * ever look back at: a former generation keeps its bytes only for a reader still holding a
   * delivery record that names them, and a finished attempt only for a commit still in flight.
   */
  readonly retainNoncurrentUnrecordedMs: number;
  readonly retainHistoryUnrecordedMs: number;
  readonly projectionSliceMs: number;
}

export function limitsOf(vars: Vars): ScopeLimits {
  return {
    entriesPerScope: vars.QUOTA_ENTRIES_PER_SCOPE,
    attemptsPerMinute: vars.QUOTA_ATTEMPTS_PER_MINUTE,
    bodyBytesPerScope: vars.QUOTA_BODY_BYTES_PER_SCOPE,
    tagsPerScope: vars.QUOTA_TAGS_PER_SCOPE,
    maxArtifactBytes: vars.MAX_ARTIFACT_BYTES,
    maxRecordBytes: MAX_PACK_BYTES,
    leaseMs: vars.LEASE_SECONDS * MILLISECONDS_PER_SECOND,
    retainNoncurrentMs: vars.RETAIN_NONCURRENT_DAYS * SECONDS_PER_DAY * MILLISECONDS_PER_SECOND,
    retainNoncurrentGenerations: vars.RETAIN_NONCURRENT_GENERATIONS,
    retainHistoryMs: vars.RETAIN_HISTORY_DAYS * SECONDS_PER_DAY * MILLISECONDS_PER_SECOND,
    retainNoncurrentUnrecordedMs:
      vars.RETAIN_NONCURRENT_UNRECORDED_HOURS * SECONDS_PER_HOUR * MILLISECONDS_PER_SECOND,
    retainHistoryUnrecordedMs:
      vars.RETAIN_HISTORY_UNRECORDED_HOURS * SECONDS_PER_HOUR * MILLISECONDS_PER_SECOND,
    projectionSliceMs: PROJECTION_SLICE_MS,
  };
}
