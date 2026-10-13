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
import { releaseStream } from '@stayingupwind/core/util';
import type { RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import {
  handlePassthrough,
  type MiddlewareContinue,
  passthroughMetrics,
  type PassthroughWait,
} from '../handlers/passthrough.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';

/**
 * How the edge asks a deployment's Worker to regenerate an entry. Beside a resume already in
 * flight (`background`: the Worker regenerates once the suffix has gone out), as the response
 * itself when no valid generation exists (`foreground`), or as a request of its own, after the
 * response, for a document nothing resumes (`detached`). An isolate asks at most once per entry
 * per cooldown: one regeneration at a time is what the entry's lease allows anyway.
 */

/** Longest an isolate remembers having asked; the policy's cooldown decides, within it. */
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

/** Whether to ask now: not when this isolate asked for the entry within the cooldown. */
export function shouldAsk(
  edge: EdgeContext,
  entryId: string,
  settings: RuntimeCacheSettings,
): boolean {
  const key = `${edge.manifestId}:${entryId}`;
  const askedAt = edge.runtime.memory.regenerations.get(key);
  const now = edge.runtime.now();
  if (askedAt !== undefined && now - askedAt < settings.regenerateCooldownMs) {
    return false;
  }
  edge.runtime.memory.regenerations.set(key, now);
  return true;
}

export interface DispatchInput {
  readonly request: Request;
  readonly middleware: MiddlewareContinue | undefined;
  readonly target: RegenerationTarget;
  /** The app Worker the entry's route is in, for a deployment split across several. */
  readonly function: string | undefined;
}

/**
 * No valid generation exists: the Worker renders the page, publishes it, and its render is the
 * response — the same request the Worker would answer in full, told what it is for. Counted with
 * the read of the record that turned out to have expired, which the request waited on first.
 */
export function foregroundDocument(
  edge: EdgeContext,
  input: DispatchInput,
  { recordLookupMs }: PassthroughWait = {},
): Promise<Response> {
  return handlePassthrough({
    request: input.request,
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
    metrics: {
      ...passthroughMetrics(edge, input.target.pack.header.route),
      ...(recordLookupMs !== undefined && { recordLookupMs }),
    },
  });
}

async function askDetached(edge: EdgeContext, input: DispatchInput): Promise<void> {
  try {
    const response = await handlePassthrough({
      request: input.request,
      forwarding: edge.forwarding,
      runtime: edge.runtime,
      host: edge.host,
      app: edge.app,
      function: input.function ?? PRIMARY_FUNCTION,
      reason: 'regenerate-detached',
      middleware: input.middleware,
      headers: regenerationHeaders(edge, 'detached', input.target),
    });
    releaseStream(response.body, 'detached regeneration answered');
  } catch (error) {
    logWarn('detached regeneration not asked', {
      entryId: input.target.entryId,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** After the response: a request of its own, whose answer nobody reads. */
export function triggerDetached(edge: EdgeContext, input: DispatchInput): void {
  edge.ctx.waitUntil(askDetached(edge, input));
}
