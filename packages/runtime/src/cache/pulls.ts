import {
  parseScopeRevision,
  SCOPE_REVISION_HEADER,
  type ScopeRevision,
} from '@stayingupwind/core/paas';
import { withDeadline } from '@stayingupwind/core/util';

import { nowMs } from './clock.ts';
import type { CacheRuntime } from './runtime.ts';

/**
 * A pull of the scope's tag delta that the requests needing this isolate's view at a revision join
 * while it is out: the segments of a page prefetched together are behind the same invalidation, and
 * the first of them to find it pulls it for all of them (`renderSpeculative`, in `generations.ts`).
 */

/**
 * The pull each runtime has out, when it went out on the isolate's own clock, and whether it has
 * settled. Joined while it is out and younger than the hold; older, it may be a pull whose request
 * ended under it, which never answers.
 */
interface SharedPull {
  readonly pull: Promise<void>;
  readonly since: number;
  settled: boolean;
}

const pulls = new WeakMap<CacheRuntime, SharedPull>();

/** How many pulls a request makes or joins to bring the view up to the revision it needs. */
const PULLS_TO_CATCH_UP = 2;

/** A pull of the delta for the requests after it to join while it is out. Never rejects. */
function startPull(runtime: CacheRuntime): Promise<void> {
  const underWay: { pull: Promise<void>; readonly since: number; settled: boolean } = {
    pull: Promise.resolve(),
    since: performance.now(),
    settled: false,
  };
  underWay.pull = (async () => {
    try {
      await runtime.tags.sync(runtime.host, nowMs(), { force: true });
    } catch {
      // A pull that fails leaves the view as it stood, as a regeneration's does.
    } finally {
      underWay.settled = true;
    }
  })();
  pulls.set(runtime, underWay);
  return underWay.pull;
}

/**
 * Bring this isolate's view of the tags up to `required` — the revision a prefetch's record was
 * invalidated at, say: joining a pull that is out, or making one, and again where it left the view
 * short — a pull that went out before the invalidation answers with the revision before it. None is
 * made or joined past `until`, on the isolate's own clock: the request has gone on without the view
 * by then, and a pull made for it would be one no request waits for.
 */
export async function catchUp(
  runtime: CacheRuntime,
  required: number,
  until: number,
): Promise<void> {
  for (
    let tries = 0;
    tries < PULLS_TO_CATCH_UP && runtime.tags.revision < required && performance.now() < until;
    tries += 1
  ) {
    const underWay = pulls.get(runtime);
    const joinable =
      underWay !== undefined &&
      !underWay.settled &&
      performance.now() - underWay.since < runtime.holdMs;
    await (joinable ? underWay.pull : startPull(runtime));
  }
}

/** Once `promise` has settled, whichever way, or `ms` have gone by. */
export async function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  const settled = (async () => {
    try {
      await promise;
    } catch {
      // A pull that fails leaves the view as it stood, as a regeneration's does.
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long a request waits for its isolate's view to catch up with its scope (`catchUpWithScope`). */
const SCOPE_CATCH_UP_MS = 1000;
/** How long a request waits for its host to say where its scope stands (`scopeRevision`). */
const SCOPE_REVISION_DEADLINE_MS = 100;
const MS_PER_MINUTE = 60_000;
const RECENT_INVALIDATION_MINUTES = 10;
/**
 * How long after a scope's latest invalidation a view behind it is brought up before a request is
 * judged: past it, what the invalidation did is in what the isolate reads anyway — the records the
 * host rewrote, the tag records it wrote — however far behind those reads may still be.
 */
const RECENT_INVALIDATION_MS = RECENT_INVALIDATION_MINUTES * MS_PER_MINUTE;

/**
 * Where the request's scope stands: as the request says (`SCOPE_REVISION_HEADER`), or, where it
 * says nothing, as the host knows it nearby (`CacheHost.scopeRevision`), for a moment at the most.
 */
async function scopeOf(
  runtime: CacheRuntime,
  request: Request,
): Promise<ScopeRevision | undefined> {
  const said = parseScopeRevision(request.headers.get(SCOPE_REVISION_HEADER));
  if (said !== undefined || runtime.host.scopeRevision === undefined) {
    return said;
  }
  try {
    return await withDeadline(
      runtime.host.scopeRevision(),
      SCOPE_REVISION_DEADLINE_MS,
      'where the scope stands',
    );
  } catch {
    // Not told in time: the request goes on with the view as it stands, as it did before.
    return undefined;
  }
}

/**
 * Bring this isolate's view of the tags up to where the request's scope stands (`scopeOf`) before
 * anything the request answers is judged against it: another isolate's invalidation reaches this
 * one through its reads otherwise, which a host may cache for half a minute and more.
 *
 * Only where the view is behind the scope's latest invalidation, and that invalidation is recent
 * (`RECENT_INVALIDATION_MS`). For a second at the most (`SCOPE_CATCH_UP_MS`), joining a pull that is
 * out (`catchUp`): past it the request goes on with the view as it stands, and the pull goes on
 * behind it for as long as the requests after it may join it.
 */
export async function catchUpWithScope(
  runtime: CacheRuntime,
  request: Request,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<void> {
  const scope = await scopeOf(runtime, request);
  const invalidatedAt = scope?.invalidatedAt ?? null;
  if (
    scope === undefined ||
    invalidatedAt === null ||
    scope.revision <= runtime.tags.revision ||
    nowMs() - invalidatedAt > RECENT_INVALIDATION_MS
  ) {
    return;
  }
  const caughtUp = catchUp(runtime, scope.revision, performance.now() + SCOPE_CATCH_UP_MS);
  waitUntil(settledWithin(caughtUp, runtime.holdMs));
  await settledWithin(caughtUp, SCOPE_CATCH_UP_MS);
}
