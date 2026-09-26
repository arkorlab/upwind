import { z } from 'zod';

/**
 * Time as the cache records it.
 *
 * A duration is finite seconds, unbounded, or unknown; a deadline is an instant in unix
 * milliseconds, never, or unknown. The three-way split is the point: a record from before a
 * lifetime was recorded says `unknown`, which no reader may turn into "never expires", and a route
 * that Next.js marks `revalidate: false` says `unbounded`, which means no time-based revalidation
 * and nothing about on-demand invalidation. Internal times are UTC unix milliseconds; durations are
 * seconds, as Next.js hands them over. Display and time zones are someone else's concern.
 */

const MILLISECONDS_PER_SECOND = 1000;
/** `CACHE_ONE_YEAR` in Next.js: what `s-maxage` says when a route has no time-based revalidation. */
export const NEXT_ONE_YEAR_SECONDS = 31_536_000;

export const durationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('finite'), seconds: z.number().nonnegative() }),
  z.object({ kind: z.literal('unbounded') }),
  z.object({ kind: z.literal('unknown') }),
]);
export type Duration = z.infer<typeof durationSchema>;

export const deadlineSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), unixMs: z.number().int() }),
  z.object({ kind: z.literal('never') }),
  z.object({ kind: z.literal('unknown') }),
]);
export type Deadline = z.infer<typeof deadlineSchema>;

const BUILD_OUTPUT = 'build-output';
const RUNTIME_OUTPUT = 'runtime-output';
const LEGACY_UNKNOWN = 'legacy-unknown';

/** Where a policy's numbers came from; `legacy-unknown` is a record that predates them. */
export const cachePolicySourceSchema = z.enum([BUILD_OUTPUT, RUNTIME_OUTPUT, LEGACY_UNKNOWN]);
export type CachePolicySource = z.infer<typeof cachePolicySourceSchema>;

export const cachePolicySchema = z.object({
  revalidateAfter: durationSchema,
  expireAfter: durationSchema,
  /** For the client router only; never part of a server-side expiry. */
  clientStale: durationSchema,
  source: cachePolicySourceSchema,
});
export type CachePolicy = z.infer<typeof cachePolicySchema>;

export const cacheTimingSchema = z.object({
  /** When Next.js says the generation was made; `null` when the origin is not recorded. */
  cacheTimestamp: z.number().int().nullable(),
  producedAt: z.number().int().nullable(),
  revalidateAt: deadlineSchema,
  expireAt: deadlineSchema,
});
export type CacheTiming = z.infer<typeof cacheTimingSchema>;

export const UNBOUNDED_DURATION: Duration = { kind: 'unbounded' };
export const UNKNOWN_DURATION: Duration = { kind: 'unknown' };
export const NEVER_DEADLINE: Deadline = { kind: 'never' };
export const UNKNOWN_DEADLINE: Deadline = { kind: 'unknown' };

export function finiteSeconds(seconds: number): Duration {
  return { kind: 'finite', seconds };
}

/**
 * Next.js `revalidate`: `false` is a route with no time-based revalidation — still invalidated on
 * demand — and absent is a record that never said.
 */
export function durationFromRevalidate(value: number | false | undefined): Duration {
  if (value === undefined) {
    return UNKNOWN_DURATION;
  }
  return value === false ? UNBOUNDED_DURATION : finiteSeconds(value);
}

/** Next.js `expire`: absent means stale content may be served for as long as it is asked for. */
export function durationFromExpire(value: number | undefined): Duration {
  return value === undefined ? UNBOUNDED_DURATION : finiteSeconds(value);
}

export interface BuildPolicyInput {
  readonly initialRevalidate?: number | false | undefined;
  readonly initialExpiration?: number | undefined;
  /** The `x-nextjs-stale-time` the build recorded, in seconds, when it did. */
  readonly clientStale?: number | undefined;
}

/**
 * The lifetime the build gave a prerender. An expiration is only meaningful next to a known
 * revalidation, so a prerender whose revalidation the bundle does not carry has an unknown
 * expiration too, rather than the unbounded one an absent `initialExpiration` would mean.
 */
export function policyFromBuild(input: BuildPolicyInput): CachePolicy {
  const revalidateAfter = durationFromRevalidate(input.initialRevalidate);
  return {
    revalidateAfter,
    expireAfter:
      revalidateAfter.kind === 'unknown'
        ? UNKNOWN_DURATION
        : durationFromExpire(input.initialExpiration),
    clientStale:
      input.clientStale === undefined ? UNKNOWN_DURATION : finiteSeconds(input.clientStale),
    source: BUILD_OUTPUT,
  };
}

/** `cacheEntry.cacheControl` as the app page runtime hands it to `onCacheEntryV2`. */
export interface RuntimeCacheControl {
  readonly revalidate: number | false;
  readonly expire?: number | undefined;
}

export function policyFromCacheControl(
  control: RuntimeCacheControl,
  clientStale?: number,
): CachePolicy {
  return {
    revalidateAfter: durationFromRevalidate(control.revalidate),
    expireAfter: durationFromExpire(control.expire),
    clientStale: clientStale === undefined ? UNKNOWN_DURATION : finiteSeconds(clientStale),
    source: RUNTIME_OUTPUT,
  };
}

function cacheControlDirectives(value: string): Map<string, string | undefined> {
  const directives = new Map<string, string | undefined>();
  for (const part of value.split(',')) {
    const [rawName, rawValue] = part.split('=', 2);
    const name = rawName?.trim().toLowerCase();
    if (name !== undefined && name !== '') {
      directives.set(name, rawValue?.trim());
    }
  }
  return directives;
}

function secondsDirective(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * The lifetime a route handler or a Pages ISR response states, in the header Next.js writes for it:
 * `s-maxage=<revalidate>[, stale-while-revalidate=<expire - revalidate>]`, with `s-maxage` of one
 * year standing for `revalidate: false` — read back into what `cacheControl` would have said. A
 * directive that disables caching is not a lifetime, and a header without `s-maxage` says nothing
 * this can read.
 */
export function runtimeCacheControlFromHeader(
  value: string | null | undefined,
): RuntimeCacheControl | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const directives = cacheControlDirectives(value);
  if (directives.has('no-store') || directives.has('private')) {
    return undefined;
  }
  const revalidateSeconds = secondsDirective(directives.get('s-maxage'));
  if (revalidateSeconds === undefined) {
    return undefined;
  }
  const staleWhileRevalidate = secondsDirective(directives.get('stale-while-revalidate'));
  return {
    revalidate: revalidateSeconds >= NEXT_ONE_YEAR_SECONDS ? false : revalidateSeconds,
    expire:
      staleWhileRevalidate === undefined ? undefined : revalidateSeconds + staleWhileRevalidate,
  };
}

/** The policy of a route handler or Pages ISR response, from its `cache-control` header. */
export function policyFromCacheControlHeader(
  value: string | null | undefined,
): CachePolicy | undefined {
  const control = runtimeCacheControlFromHeader(value);
  return control === undefined ? undefined : policyFromCacheControl(control);
}

/** The policy of a record that predates lifetimes: everything unknown, nothing assumed. */
export function policyUnknown(): CachePolicy {
  return {
    revalidateAfter: UNKNOWN_DURATION,
    expireAfter: UNKNOWN_DURATION,
    clientStale: UNKNOWN_DURATION,
    source: LEGACY_UNKNOWN,
  };
}

/** The instant `duration` after `originMs`; unknown when either side is. */
export function deadlineAfter(originMs: number | null, duration: Duration): Deadline {
  if (originMs === null || duration.kind === 'unknown') {
    return UNKNOWN_DEADLINE;
  }
  if (duration.kind === 'unbounded') {
    return NEVER_DEADLINE;
  }
  return { kind: 'at', unixMs: originMs + duration.seconds * MILLISECONDS_PER_SECOND };
}

export interface TimingInput {
  readonly cacheTimestamp: number | null;
  readonly producedAt: number | null;
  readonly policy: CachePolicy;
}

/** The deadlines of a generation, from the moment Next.js gave it and the lifetime it stated. */
export function timingOf(input: TimingInput): CacheTiming {
  return {
    cacheTimestamp: input.cacheTimestamp,
    producedAt: input.producedAt,
    revalidateAt: deadlineAfter(input.cacheTimestamp, input.policy.revalidateAfter),
    expireAt: deadlineAfter(input.cacheTimestamp, input.policy.expireAfter),
  };
}
