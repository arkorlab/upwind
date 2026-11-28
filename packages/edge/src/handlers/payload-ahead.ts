import { kvGenerationKey } from '@stayingupwind/core/cache';
import type { RouteEntry } from '@stayingupwind/core/manifest';
import { NEXT_ROUTER_PREFETCH_HEADER, type RequestClass } from '@stayingupwind/core/request';
import { runtimeCacheOf, type RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import { type GenerationKey, generationAsHeld } from '../cache/generation-hold.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import {
  memberFlightUnproved,
  memberOfClass,
  type PartInput,
  readHeldPartAgain,
} from './hosted-parts.ts';
import { generationKeyOf } from './hosted-route.ts';

/**
 * A router's request for a page's whole payload that the edge could only hand on to the Function
 * once the application's middleware ran, known before it runs — and handed on then, for the
 * Function to run the middleware itself (`routeHostedDocument`).
 *
 * Run here first, the middleware is a dispatch to its Worker — a cold one's start among it — and
 * the request a second one, to the Function, behind it: two round trips in series where a plain
 * `rsc` request takes one. What the visitor is sent is the Function's answer either way: the
 * middleware's redirect or response, or the page's Flight rendered for the request. All but one
 * thing, as for a plain `rsc` request (`servedAtEdge`): a rewrite onto a file the build shipped,
 * which the edge serves from storage, and which the Function carries only the small ones of.
 *
 * Two kinds, each judged on the request as it came, since nothing has changed it yet:
 *
 * - a member of a class the build made a shell of, whose record proves no member's Flight, under a
 *   policy that reads no member's own (`memberFlightUnproved`);
 * - a page the build wrote no payload of, asked for other than as a static prefetch, whose record
 *   holds the state a resume finishes, which only the Function's render answers such a request from
 *   (`answerPart`). Known by the record this isolate holds, looked at without being used (`peek`):
 *   one it serves from is touched as it is served. Holding none, by the build's word for the page
 *   (`delivery`), with the record read behind the response for the next request to be judged by — a
 *   page rendered since may be whole where the build's prerender was not. Not under a hold of zero,
 *   which holds nothing and reads every record before the first byte: a setting for measuring that
 *   read, which the build's word would skip.
 *
 * Every other request runs the middleware here: a route whose record the edge serves nothing from
 * (`generationKeyOf`); a member of a class with no shell, served from its own record
 * (`serveMemberWithoutShell`); a partial fallback's member, served from its completion where one is
 * held, whatever the policy (`partialPartGeneration`); a page the build wrote a payload of; a member
 * the policy reads its own record of; a static prefetch, which saved partial Flight answers; and a
 * page whose held record is whole.
 */

/** Why a request for a page's whole payload goes to the Function before its middleware has run. */
const RSC_PAYLOAD_AHEAD = 'rsc-payload-ahead';

/** What is read of a hosted document's request to judge it (`HostedDocumentInput`). */
interface AheadInput extends PartInput {
  readonly classification: RequestClass;
  /** The headers the request was classified on, which one no middleware ran for is judged on. */
  readonly classifiedHeaders: Headers;
}

/**
 * Hand a request for a page's whole payload on to the Function before the middleware runs, where
 * the edge could only hand it on once it ran; `undefined` for any other request.
 */
export function payloadAhead(input: AheadInput): Promise<Response> | undefined {
  const { classification } = input;
  if (classification.kind !== 'rsc-payload' || classification.entry === undefined) {
    return undefined;
  }
  const { entry } = classification;
  return onlyTheFunctions(input, entry)
    ? input.passthrough(RSC_PAYLOAD_AHEAD, undefined, entry.pathname)
    : undefined;
}

/** Whether the payload asked for of `entry` is one the edge could only hand on (`payloadAhead`). */
function onlyTheFunctions(input: AheadInput, entry: RouteEntry): boolean {
  const key = entry.partialFallback === undefined ? generationKeyOf(input, entry) : undefined;
  if (key === undefined) {
    return false;
  }
  const settings = runtimeCacheOf(input.edge.policy);
  const { pathname } = input.url;
  if (memberFlightUnproved(settings, entry, pathname)) {
    return true;
  }
  return (
    !memberOfClass(entry, pathname) &&
    entry.payload === undefined &&
    settings.holdMs !== 0 &&
    input.classifiedHeaders.get(NEXT_ROUTER_PREFETCH_HEADER) !== '1' &&
    resumedRecord(input, { key, entry, settings })
  );
}

/**
 * Whether the page's record holds the state a resume finishes, as far as this isolate can tell
 * without waiting on a read: the record it holds — its regeneration asked for where answering after
 * the middleware would have asked it (`readHeldPartAgain`) — or, holding none, the build's word
 * (`delivery`), the record then read behind the response.
 */
function resumedRecord(
  input: AheadInput,
  page: {
    readonly key: GenerationKey;
    readonly entry: RouteEntry;
    readonly settings: RuntimeCacheSettings;
  },
): boolean {
  const { edge } = input;
  const { key, entry, settings } = page;
  const held = edge.runtime.memory.generations.peek(kvGenerationKey(key.scopeId, key.entryId));
  if (held !== undefined) {
    if (held.pack.header.postponedSha256 === null) {
      return false;
    }
    readHeldPartAgain(input, held.pack);
    return true;
  }
  if (entry.cache?.delivery !== 'resume') {
    return false;
  }
  edge.ctx.waitUntil(readBehind(edge, key, settings));
  return true;
}

/**
 * Read the page's record behind a request handed on for want of it, as the request would have read
 * it once the middleware ran (`generationAsHeld`): the next is judged by the record, not the build.
 */
async function readBehind(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
): Promise<void> {
  try {
    await generationAsHeld(edge, key, settings);
  } catch (error) {
    logWarn('delivery record read behind a payload handed on failed', {
      key: kvGenerationKey(key.scopeId, key.entryId),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
