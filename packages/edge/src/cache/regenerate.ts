import { PRIMARY_FUNCTION } from '@stayingupwind/core/bundle';
import type { DecodedGenerationPack } from '@stayingupwind/core/cache';
import {
  CACHE_ENTRY_HEADER,
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_ROUTE_HEADER,
  CACHE_UPGRADE_HEADER,
  GENERATION_HEADER,
  GENERATION_SEQ_HEADER,
  pathHeaders,
  REGENERATE_HEADER,
  type RegenerateMode,
  SERVED_GENERATION_HEADER,
} from '@stayingupwind/core/paas';
import { releaseStream, withDeadline } from '@stayingupwind/core/util';
import type { RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import { observeRequestMetric } from '../handlers/observer.ts';
import {
  handlePassthrough,
  type MiddlewareContinue,
  passthroughMetrics,
  type PassthroughWait,
} from '../handlers/passthrough.ts';
import type { Dispatched } from '../handlers/upstream.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import type { EdgeContext } from '../strategies/context.ts';

/**
 * How the edge asks a deployment's Worker to regenerate an entry. Beside a resume already in
 * flight (`background`: the Worker regenerates once the suffix has gone out), as the response
 * itself when no valid generation exists (`foreground`), or as a request of its own, after the
 * response, for a document nothing resumes (`detached`). An isolate asks at most once per entry
 * per cooldown: one regeneration at a time is what the entry's lease allows anyway.
 */

/**
 * How long an isolate remembers having asked, at the least; the policy's cooldown decides within it,
 * and a cooldown longer than it is remembered for as long (`shouldAsk`).
 */
export const REGENERATION_MEMORY_TTL_MS = 3_600_000;

export interface RegenerationTarget {
  /**
   * The record the edge served: the base a regeneration replaces, or the class shell a member's own
   * entry is asked beside.
   */
  readonly pack: DecodedGenerationPack;
  readonly entryId: string;
  /**
   * The entry is a member's own (`runtimeCache.concreteUpgrade`), not the class shell's that
   * answers the member: the runtime regenerates the concrete pathname.
   */
  readonly member?: boolean | undefined;
  /**
   * The member's record is the one its class completes to (`MemberRoute.keyedBy`), which every
   * member sharing its keys is served, rather than one of its own.
   */
  readonly keyed?: boolean | undefined;
}

/**
 * Whether the runtime renders the request's own pathname rather than the record's
 * (`CACHE_UPGRADE_HEADER`): for a member's own record, and for a member asked beside the class
 * shell it was answered with. Not for a record a keyed class keeps for every member that completes
 * to it (`keyed`): rendered as the member, it would be kept under the member's own pathname, and the
 * record the edge goes on serving never replaced. Told by where the record was read, not by its
 * pathname, which a member's own may hold a bracket in as well (`/blog/[draft]`).
 */
function rendersTheMember(target: RegenerationTarget): boolean {
  return (
    target.member === true &&
    (target.entryId !== target.pack.header.entryId || target.keyed !== true)
  );
}

/** What the runtime is told beside the request: the entry, the base the edge served, and when. */
export function regenerationHeaders(
  edge: EdgeContext,
  mode: RegenerateMode,
  target: RegenerationTarget,
): Record<string, string> {
  const { header } = target.pack;
  const colo = edge.colo === undefined ? '' : `;colo=${edge.colo}`;
  return {
    [REGENERATE_HEADER]: mode,
    ...pathHeaders(CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER, header.route),
    [CACHE_ENTRY_HEADER]: target.entryId,
    ...(rendersTheMember(target) && { [CACHE_UPGRADE_HEADER]: '1' }),
    [GENERATION_HEADER]: header.generationId,
    [GENERATION_SEQ_HEADER]: String(header.seq),
    [SERVED_GENERATION_HEADER]: `${header.generationId}${colo};at=${edge.runtime.now()}`,
  };
}

/** Either id may contain a colon; the manifest's length keeps the pair distinct. */
function regenerationKey(manifestId: string, entryId: string): string {
  return `${String(manifestId.length)}:${manifestId}:${entryId}`;
}

/** Whether to ask now: not when this isolate asked for the entry within the cooldown. */
export function shouldAsk(
  edge: EdgeContext,
  entryId: string,
  settings: RuntimeCacheSettings,
): boolean {
  const key = regenerationKey(edge.manifestId, entryId);
  const asked = edge.runtime.memory.regenerations.get(key);
  const now = edge.runtime.now();
  if (asked !== undefined && now - asked.at < settings.regenerateCooldownMs) {
    return false;
  }
  // Kept for the whole cooldown: forgotten sooner, the entry would be asked for again within it.
  const keptMs = Math.max(REGENERATION_MEMORY_TTL_MS, settings.regenerateCooldownMs);
  edge.runtime.memory.regenerations.set(key, { at: now }, keptMs);
  return true;
}

/**
 * Let this ask be made again if its resume is abandoned before it answers. An answer hands the
 * background job to the runtime; before it exists there may be no job to run. Only this ask is
 * given back: an older visitor leaving cannot undo a newer ask, even with the same clock reading.
 */
export function allowAnotherAsk(edge: EdgeContext, entryId: string): () => void {
  const key = regenerationKey(edge.manifestId, entryId);
  const asked = edge.runtime.memory.regenerations.get(key);
  return () => {
    if (asked !== undefined && edge.runtime.memory.regenerations.get(key) === asked) {
      edge.runtime.memory.regenerations.delete(key);
    }
  };
}

export interface DispatchInput {
  readonly request: Request;
  readonly middleware: MiddlewareContinue | undefined;
  readonly target: RegenerationTarget;
  /** The app Worker the entry's route is in, for a deployment split across several. */
  readonly function: string | undefined;
}

/**
 * The visitor's request as a regeneration is sent with it, but not cancelled with it, as a
 * passthrough is (`buildPassthroughRequest`): what a regeneration renders is published for every
 * visitor after this one, and one who leaves before the Worker answers does not take it with them.
 */
function keptPastTheVisitor(request: Request): Request {
  return new Request(request, { signal: null });
}

/**
 * No valid generation exists: the Worker renders the page, publishes it, and its render is the
 * response — the same request the Worker would answer in full, told what it is for. Counted with
 * the read of the record that turned out to have expired, which the request waited on first. Where
 * the Workers that served the record are gone, the request is routed again from the pointer KV
 * holds now, as any passthrough of it is (`EdgeContext.whenGone`).
 */
export function foregroundDocument(
  edge: EdgeContext,
  input: DispatchInput,
  { recordLookupMs }: PassthroughWait = {},
): Promise<Response> {
  return handlePassthrough({
    request: keptPastTheVisitor(input.request),
    forwarding: edge.forwarding,
    runtime: edge.runtime,
    host: edge.host,
    app: edge.app,
    cspReportingPath: edge.cspReportingPath,
    function: input.function ?? PRIMARY_FUNCTION,
    reason: 'regenerate',
    privateDelivery: edge.privateDelivery,
    middleware: input.middleware,
    headers: regenerationHeaders(edge, 'foreground', input.target),
    whenGone: edge.whenGone,
    metrics: {
      ...passthroughMetrics(edge, input.target.pack.header.route),
      ...(recordLookupMs !== undefined && { recordLookupMs }),
    },
  });
}

/**
 * A regeneration asked behind the response as a request of its own (`triggerDetached`). What it asks
 * of the application's Workers is spent for the request it was asked behind, and is counted in that
 * request's point: a point of its own would count a request no client made.
 */
export interface DetachedRegeneration {
  /**
   * Write the point of the request it was asked behind once the regeneration has been answered or
   * has failed, with its dispatches among the point's `subrequests` — one, or two where the Worker
   * first asked named another: behind the response, held as the regeneration is, though no longer
   * than `DETACHED_ANSWER_WAIT_MS`, with those it has made by then.
   */
  readonly record: (point: EdgeMetric) => void;
}

/**
 * How long the point of the request a regeneration was asked behind waits for that regeneration's
 * answer. A Worker that never answers would otherwise cost the point of a request answered long
 * before, past the time its context lets work go on behind it: the point is written then with the
 * requests that have gone out by then counted — the Worker first asked, and the one it named where
 * it has named another (`dispatchesMade`).
 */
export const DETACHED_ANSWER_WAIT_MS = 5000;

/** Wait for a detached regeneration's answer, though no longer than `DETACHED_ANSWER_WAIT_MS`. */
async function answeredWithin(answered: Promise<void>): Promise<void> {
  try {
    await withDeadline(answered, DETACHED_ANSWER_WAIT_MS, 'detached regeneration answer');
  } catch {
    // Still out: what it has asked so far is what is counted.
  }
}

/**
 * Ask, and hand `asked`, as the request goes out, what reads how much it has asked of the
 * application's Workers so far.
 */
async function askDetached(
  edge: EdgeContext,
  input: DispatchInput,
  asked: (soFar: () => number) => void,
  onDispatched?: (read: () => Dispatched | undefined) => void,
): Promise<void> {
  try {
    const response = await handlePassthrough({
      request: keptPastTheVisitor(input.request),
      forwarding: edge.forwarding,
      runtime: edge.runtime,
      host: edge.host,
      app: edge.app,
      function: input.function ?? PRIMARY_FUNCTION,
      reason: 'regenerate-detached',
      middleware: input.middleware,
      headers: regenerationHeaders(edge, 'detached', input.target),
      onAsked: asked,
      onDispatched,
    });
    releaseStream(response.body, 'detached regeneration answered');
  } catch (error) {
    logWarn('detached regeneration not asked', {
      entryId: input.target.entryId,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * After the response: a request of its own, whose answer nobody reads, counted in the point of the
 * request it was asked behind (`DetachedRegeneration`).
 */
export function triggerDetached(
  edge: EdgeContext,
  input: DispatchInput,
  options?: { readonly attributeFunction?: boolean },
): DetachedRegeneration {
  // Never handed where the request never went out: nothing was asked.
  let soFar: (() => number) | undefined;
  let dispatched: (() => Dispatched | undefined) | undefined;
  const answered = askDetached(
    edge,
    input,
    (reader) => {
      soFar = reader;
    },
    options?.attributeFunction === true
      ? (reader) => {
          dispatched = reader;
        }
      : undefined,
  );
  edge.ctx.waitUntil(answered);
  return {
    record: (point) => {
      edge.ctx.waitUntil(
        (async (): Promise<void> => {
          await answeredWithin(answered);
          const dispatches = soFar?.() ?? 0;
          const worker = dispatches === 0 ? undefined : observedDispatch(dispatched);
          observeRequestMetric(edge, {
            ...point,
            subrequests: point.subrequests + dispatches,
            ...(worker !== undefined && { fn: worker.fn, redispatch: worker.redispatched ? 1 : 0 }),
          });
        })(),
      );
    },
  };
}

/** Optional accounting cannot change whether a response or a regeneration succeeds. */
function observedDispatch(
  read: (() => Dispatched | undefined) | undefined,
): Dispatched | undefined {
  try {
    return read?.();
  } catch {
    return undefined;
  }
}
