import { deploymentFingerprintSchema } from '@stayingupwind/core/deployment';
import { appRuntimeSchema } from '@stayingupwind/core/manifest';
import * as z from '@stayingupwind/core/schema';

/** Whether the edge adds nonce sources to the enforcing policy or to a reporting copy. */
export const cspNonceModeSchema = z.enum(['enforce', 'report-only']);
export type CspNonceMode = z.infer<typeof cspNonceModeSchema>;

/**
 * Delivery policy: how artifacts are physically served on Cloudflare. This is deliberately
 * separate from the manifest so backends can change without touching what a build produced.
 */
export const shellBackendIdSchema = z.enum(['kv', 'r2', 'static-assets']);
export type ShellBackendId = z.infer<typeof shellBackendIdSchema>;

/**
 * Where an asset the manifest does not name comes from. `r2-mirror` and `cache-api-readthrough`
 * are the same read-through of the deployment's own Worker, told apart so a measurement can.
 */
export const assetBackendIdSchema = z.enum(['cache-api-readthrough', 'passthrough', 'r2-mirror']);
export type AssetBackendId = z.infer<typeof assetBackendIdSchema>;

/**
 * A policy id travels in the `;`-delimited `x-arkor-edge` header, and validation splits that header
 * to ask which policy answered. An id carrying a separator could never match its own response, so
 * a policy under one would be accepted and then fail every validation it was ever put through.
 */
const POLICY_ID_PATTERN = /^[\w.-]{1,64}$/u;

/** What the edge does with a hosted application's runtime cache; see `DeliveryPolicy.runtimeCache`. */
export const runtimeCacheSettingsSchema = z.object({
  /** Serve documents from the cache's delivery records, and ask for their regeneration. */
  generations: z.enum(['off', 'on']),
  /**
   * How long an isolate serves a delivery record it read before it asks KV again. Past it the
   * record is still served, and KV is asked behind that response: a change reaches an isolate one
   * request later. KV's regional cache and eventual consistency also contribute to invalidation
   * propagation time. Zero holds nothing, and every request asks KV before its first byte.
   */
  holdMs: z.number().int().nonnegative(),
  /** How long after asking for an entry's regeneration an isolate asks for none again. */
  regenerateCooldownMs: z.number().int().nonnegative(),
  /**
   * Read a member's own generation beside the class shell that would otherwise answer it, in
   * parallel, and serve it when there is one; ask the Worker to make one when there is none. A
   * member is then a shell rendered for its own parameters, and an entry of its own — one per
   * member the deployment serves — where the class shell alone is one entry for them all.
   */
  concreteUpgrade: z.boolean(),
  /**
   * How long a data center's copy of a delivery record — kept in the Cache API beside KV — may
   * answer without KV having confirmed it. An isolate that does not hold the record reads the copy
   * and KV together and serves whichever answers first; KV's answer then replaces a copy it has
   * moved past, for the next request in that data center. Absent or zero, no copy is kept or read,
   * and every record comes from the isolate's memory or from KV. A host can turn the copies off
   * for one project whatever its policy says (`EdgePointer.cacheApi`). The edge reads more than 50
   * minutes as 50:
   * an isolate keeps an at-once invalidation for an hour, and a copy from before one must not
   * outlive it.
   */
  cacheApiMaxAgeMs: z.number().int().nonnegative().optional(),
});
export type RuntimeCacheSettings = z.infer<typeof runtimeCacheSettingsSchema>;

/**
 * A middleware is application code and may read a cookie, a header, or call out; the budget is
 * wide enough for that and still one that leaves the shell ahead of any render.
 */
const DEFAULT_MIDDLEWARE_CPU_MS = 50;
const DEFAULT_MIDDLEWARE_SUBREQUESTS = 5;

/**
 * Wide enough for a middleware bundle nothing has loaded yet, and for a large one every time.
 *
 * An application's middleware is a Worker of its own, and the first request to reach a cold
 * isolate of it pays for compiling the bundle: a few hundred milliseconds for a large bundle,
 * against a few once warm, and well inside the CPU budget either way — and a bundle of tens of
 * mebibytes can take that long on every request, cold or not. What makes the deadline worth
 * widening is not what a cold start costs but what missing it costs: the request is given up on
 * and sent whole to the deployment's Worker, which renders the document from nothing — seconds,
 * where a shell takes a fraction of one. A middleware that hangs is still cut off.
 *
 * Three seconds is chosen to clear that tail rather than to sit against it, and a middleware that
 * has genuinely stopped is still cut off well inside the continuation's own budget. What it costs
 * is the failures: a middleware that will never answer holds the request three seconds before the
 * Worker is given the whole document. That is the trade, and it is the right way round — a
 * middleware past a tight deadline is far more often slow than hung.
 *
 * What settles the number is `middlewareMs` in the metric the edge hands its host
 * (`EdgeObserver.metric`, `metrics.ts` in the edge): the tail of real traffic says whether three
 * seconds is generous or still mean, which a handful of requests cannot.
 *
 * Changing it moves the default policy's id, since a stored document is read by the id its pointer
 * names (`RETIRED_MIDDLEWARE_TIMEOUT_MS`). **A policy id is not a thing an application can see**: a
 * deployment that fails on every route under a new id fails for a reason of its own, and the place
 * to look is what the application itself reports of its errors.
 */
const MIDDLEWARE_TIMEOUT_MS = 3000;
/** What the policies before this one gave it, and go on giving it: a pointer names what it named. */
const RETIRED_MIDDLEWARE_TIMEOUT_MS = 1000;

/**
 * The middleware budget of a policy that states none: the default policy's
 * (`DEFAULT_DELIVERY_POLICY`). One budget, read in both places: a smaller one here would time out
 * every cold middleware isolate under a policy that leaves the budget out, and send its documents
 * to a full render.
 */
const DEFAULT_MIDDLEWARE_BUDGET = {
  cpuMs: DEFAULT_MIDDLEWARE_CPU_MS,
  subRequests: DEFAULT_MIDDLEWARE_SUBREQUESTS,
  timeoutMs: MIDDLEWARE_TIMEOUT_MS,
} as const;

export const deliveryPolicySchema = z.object({
  id: z.string().regex(POLICY_ID_PATTERN, 'policy id'),
  shell: z.object({
    backend: shellBackendIdSchema,
    /** Keep hot shells in isolate memory (byte-budgeted LRU). */
    memoryLru: z.boolean(),
    /** Layer the per-data-center Cache API between memory and the backend. */
    cacheApiLayer: z.boolean(),
  }),
  assets: z.object({
    backend: assetBackendIdSchema,
    /** What the browser is told: an admitted asset is content-addressed and never changes. */
    ttlSeconds: z.number().int().positive(),
    /**
     * What shared caches are told, through `s-maxage`.
     *
     * Bound the lifetime of shared entries independently of the browser's immutable lifetime.
     * The edge's Cache API re-applies the active policy on every hit; the outer Workers Cache is
     * disabled because its key is the origin's URL alone, not the hostname the visitor asked at,
     * which an application's middleware may answer differently.
     */
    sharedTtlSeconds: z.number().int().positive(),
  }),
  continuation: z.object({
    timeoutMs: z.number().int().positive(),
    recovery: z.literal('reload-bypass'),
  }),
  /**
   * Budget for an application's own middleware, run by the edge before a shell it holds goes out.
   *
   * It runs before the response headers are committed, so its whole cost is time-to-first-byte —
   * the one thing the edge exists to protect. A middleware past its budget does not hold the
   * document: the request goes to the application's Worker, which runs it itself.
   */
  middleware: z
    .object({
      cpuMs: z.number().int().positive(),
      subRequests: z.number().int().nonnegative(),
      timeoutMs: z.number().int().positive(),
    })
    .default(() => ({ ...DEFAULT_MIDDLEWARE_BUDGET })),
  /**
   * How an application's documents are served from its runtime cache. Absent, the edge serves the
   * build's shells as it always has; `runtimeCacheOf` reads the absence as the defaults.
   */
  runtimeCache: runtimeCacheSettingsSchema.optional(),
});
export type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;

/** How long an isolate serves a delivery record it read before it asks KV again, by default. */
const DEFAULT_GENERATION_HOLD_MS = 5000;
/** How long after asking for an entry's regeneration an isolate asks for none again, by default. */
const DEFAULT_REGENERATE_COOLDOWN_MS = 5000;
/**
 * How long a data center's copy of a record answers before KV has confirmed it, in the default
 * policy. Ten times KV's own cache in a data center (`cacheTtl`, 30 s): a page asked for less often
 * than that is read from KV's upper tiers or its storage, which is the wait the copy is there to
 * take off the first byte. What it costs: after a change, a data center where the page is seldom
 * asked for may answer with the generation before it until KV's answer to the request the copy
 * served comes back.
 */
const DEFAULT_CACHE_API_MAX_AGE_MS = 300_000;

export const DEFAULT_RUNTIME_CACHE_SETTINGS: RuntimeCacheSettings = {
  generations: 'off',
  holdMs: DEFAULT_GENERATION_HOLD_MS,
  regenerateCooldownMs: DEFAULT_REGENERATE_COOLDOWN_MS,
  concreteUpgrade: false,
};

/** The runtime cache settings a policy states, or the defaults for one that states none. */
export function runtimeCacheOf(policy: DeliveryPolicy): RuntimeCacheSettings {
  return policy.runtimeCache ?? DEFAULT_RUNTIME_CACHE_SETTINGS;
}

const ONE_YEAR_SECONDS = 31_536_000;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
/** Upper bound for an admitted asset's lifetime in a shared cache. */
const SHARED_ASSET_TTL_SECONDS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
const DEFAULT_CONTINUATION_TIMEOUT_MS = 300_000;

/**
 * What an application is served under.
 *
 * Assets come from the host's own storage, the continuation is a resume of what the build
 * postponed, and documents are served from the deployment's runtime cache — the current
 * generation of each route, regenerated behind the response as it goes stale, and kept in each
 * data center's Cache API beside KV.
 *
 * The id moves whenever what it serves does: the edge reads a policy by its id, and a pointer
 * naming one is served what was stored under it, so a changed default under the old id would
 * serve some projects one way and some the other until every copy of the document was rewritten.
 * The ids it moves to are the built-in policies' (`PLATFORM_POLICY_ID_PATTERN`); one that a policy
 * of a host's own already holds is not gone live under, but an earlier built-in, which whatever
 * deploys chooses instead.
 */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  id: 'paas-v5',
  shell: { backend: 'kv', memoryLru: true, cacheApiLayer: true },
  assets: {
    backend: 'r2-mirror',
    ttlSeconds: ONE_YEAR_SECONDS,
    sharedTtlSeconds: SHARED_ASSET_TTL_SECONDS,
  },
  continuation: { timeoutMs: DEFAULT_CONTINUATION_TIMEOUT_MS, recovery: 'reload-bypass' },
  middleware: { ...DEFAULT_MIDDLEWARE_BUDGET },
  runtimeCache: {
    ...DEFAULT_RUNTIME_CACHE_SETTINGS,
    generations: 'on',
    cacheApiMaxAgeMs: DEFAULT_CACHE_API_MAX_AGE_MS,
  },
};

/**
 * The built-in policies before this one, as they were. A pointer written under one names it
 * until its project deploys again. A deployment stores the policy it goes live with in KV
 * (`policy:<id>`), so a project that deployed under one reads it back from there; one whose pointer
 * no deployment stored a document for — a project that has only ever passed through — reads it
 * here, rather than a stand-in for a policy nobody could read.
 */
const RETIRED_DELIVERY_POLICIES: readonly DeliveryPolicy[] = [
  // The default it replaced, whose middleware had a second.
  {
    ...DEFAULT_DELIVERY_POLICY,
    id: 'paas-v4',
    middleware: {
      cpuMs: DEFAULT_MIDDLEWARE_CPU_MS,
      subRequests: DEFAULT_MIDDLEWARE_SUBREQUESTS,
      timeoutMs: RETIRED_MIDDLEWARE_TIMEOUT_MS,
    },
  },
  // Before the data center's copies of records.
  {
    ...DEFAULT_DELIVERY_POLICY,
    id: 'paas-v3',
    middleware: {
      cpuMs: DEFAULT_MIDDLEWARE_CPU_MS,
      subRequests: DEFAULT_MIDDLEWARE_SUBREQUESTS,
      timeoutMs: RETIRED_MIDDLEWARE_TIMEOUT_MS,
    },
    runtimeCache: { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'on' },
  },
];

/**
 * The built-in policy an id names: the default, or one retired, which pointers written under it
 * still name. `undefined` for any other id — a host's own policy's, or none.
 */
export function builtinDeliveryPolicy(id: string): DeliveryPolicy | undefined {
  if (id === DEFAULT_DELIVERY_POLICY.id) {
    return DEFAULT_DELIVERY_POLICY;
  }
  return RETIRED_DELIVERY_POLICIES.find((policy) => policy.id === id);
}

/** Every built-in policy, newest first: the default, then the retired ones. */
export function builtinDeliveryPolicies(): readonly DeliveryPolicy[] {
  return [DEFAULT_DELIVERY_POLICY, ...RETIRED_DELIVERY_POLICIES];
}

/**
 * The ids the built-in policies take — the current one's, the retired ones', and every one they
 * will take next — which no policy of a host's own may hold. Whatever stores a host's policies
 * refuses them; whatever deploys still checks, since a policy stored before such a refusal may
 * hold one.
 */
export const PLATFORM_POLICY_ID_PATTERN = /^paas-v\d+$/u;

export const activePointerModeSchema = z.enum(['edge', 'passthrough', 'disabled']);
export type ActivePointerMode = z.infer<typeof activePointerModeSchema>;

/** A route the edge hands the deployment's Worker whole for now (`EdgePointer.demotedRoutes`). */
const demotedRouteSchema = z.object({
  /** The route as the manifest names it: a dynamic route's class template, not a member's URL. */
  pathname: z.string().min(1),
  /**
   * When the edge splits it again. Judged on every request against the clock, so a demotion is
   * over at the moment it names whether or not the pointer has been published without it yet.
   */
  until: z.iso.datetime(),
});

/**
 * The pointer as the edge reads it: the single mutable value per site, naming everything else,
 * which is immutable and content-addressed. The origin host travels in it, so passthrough needs no
 * second lookup.
 *
 * A host stores it under the key its requests arrive with, and may stamp fields of its own beside
 * these, which the edge passes over. A host that does writes its schema out field by field, in the
 * order it stores a pointer in, rather than extending this one: a parse writes what it returns in
 * its schema's key order, as zod's does, so the order is part of the bytes a host stores.
 */
export const edgePointerSchema = z.object({
  v: z.literal(1),
  projectId: z.string().min(1),
  originHost: z.string().min(1),
  mode: activePointerModeSchema,
  reason: z.string().optional(),
  /**
   * Optional, as it has always been: a pointer that serves nothing from the edge — passed through
   * or disabled — may name no manifest, where no deployment has been activated, and the edge then
   * reads none. A pointer in `edge` mode names one.
   */
  manifestId: z.string().optional(),
  policyId: z.string().min(1),
  deployment: deploymentFingerprintSchema.optional(),
  /**
   * The project has handed CSP nonces to the edge.
   *
   * On the pointer rather than the manifest because it describes the application, not a build,
   * and a new manifest every time the project deploys must not re-decide it.
   */
  cspNonce: z.boolean().optional(),
  /** Absent on legacy pointers and in `enforce` mode; ignored while nonces are disabled. */
  cspNonceMode: cspNonceModeSchema.optional(),
  /**
   * The edge adds `'strict-dynamic'` beside each nonce it puts in a policy, so a script the
   * document's nonced scripts load is trusted and the policy's host and `'self'` sources stop
   * counting. Only `true` is written, and only beside `cspNonce`: a nonce is what the keyword hands
   * trust from, and a policy carrying it with none would run no script at all — which is why it is
   * never in an application's own policy for a document the edge does not compose.
   */
  cspStrictDynamic: z.boolean().optional(),
  /**
   * Whether the edge keeps this project's pages in each data center's Cache API beside KV; `false`
   * reads every delivery record from the isolate's memory and KV alone, whatever the policy's
   * `runtimeCache.cacheApiMaxAgeMs` says.
   *
   * Only `false` is written: absent is on, which is every project by default, and one fact has one
   * representation. Here rather than on the policy for the reason `cspNonce` is — it describes the
   * application, and the policy is chosen by deployments — and stamped on every write from the
   * host's own record of the project, so no path that builds a pointer can drop it.
   */
  cacheApi: z.boolean().optional(),
  /**
   * The Workers the deployment runs as. Named here as well as in the manifest so a pointer whose
   * manifest cannot be read still knows where to send everything.
   */
  app: appRuntimeSchema.optional(),
  /**
   * Routes of this pointer's manifest the edge does not split for now: each goes to the
   * deployment's Worker whole, a passthrough with the reason `demoted`, until its `until`. The rest
   * of the manifest is served from the edge as ever.
   *
   * Stamped by whatever writes the pointer, on every write, from its own record of the manifest's
   * demotions, so no path that builds a pointer can drop one; absent for a pointer that demotes
   * nothing, which is what a project pays for the feature — one test, no read. Unbounded here,
   * whatever bound a writer keeps: a pointer the edge cannot parse is no pointer at all, so a bound
   * raised later must not be one an older edge refuses.
   */
  demotedRoutes: z.array(demotedRouteSchema).optional(),
  updatedAt: z.iso.datetime(),
});
export type EdgePointer = z.infer<typeof edgePointerSchema>;
