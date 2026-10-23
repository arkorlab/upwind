import type { BlobRef } from '@stayingupwind/core/bundle';
import type { RouteEntry } from '@stayingupwind/core/manifest';

import { EDGE_HEADER } from './answers.ts';
import type { Accepted } from './codings.ts';
import type { Reading } from './reading.ts';

/**
 * What a part of a route goes out marked with (`part-verdicts.ts`): how Next.js marks it — postponed,
 * from the cache, rendered since — and which of its headers the edge sets over what the application
 * set (`generationHeaders`, `segmentHeaders` in the edge).
 */

/** What the edge's account of a part begins with, by the part it answered. */
export type PartKind = 'segment' | 'payload' | 'data';

/** How the client router prefetches a page's whole payload (`next-router-prefetch`). */
export type PrefetchKind = '1' | '2' | '3';

/** A part of a route, as the client router asks for it. */
export interface Part {
  readonly kind: PartKind;
  /** The part, in a verdict's words. */
  readonly what: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * What the build wrote of it: none of a resumable page's whole payload, which the edge answers
   * only from a generation the runtime rendered whole since (`composePayload` in the edge).
   */
  readonly built: BlobRef | undefined;
  /** The route it is a part of, whose recorded headers a part of a page goes out with. */
  readonly route: RouteEntry;
  /**
   * What the build wrote of the same part — the segment of the same path, the whole payload, the
   * props — of another route's page, which a request the middleware moved there is answered with.
   */
  readonly builtOn: (route: RouteEntry) => BlobRef | undefined;
  /** Whether its URL is one only the rules ahead of the filesystem claim. */
  readonly exact: boolean;
  /**
   * How it is prefetched (`next-router-prefetch`), where it is: as far as the static part (`1`),
   * which a generation a resume would finish may answer marked postponed, or with its runtime parts
   * (`2`) or as its runtime shell (`3`), which the edge leaves such a generation's Function to answer
   * (`answerPart`), as it does a navigation's.
   */
  readonly prefetch?: PrefetchKind | undefined;
  /** What the browser the router runs in accepts a part in at once (`browserCodingsOf`). */
  readonly browserCodings?: Accepted | undefined;
  /**
   * Why no request proves it, in a verdict's words, where none does: it is asked with what no
   * browser's request stands for, where what tells requests apart sees it (`stateTreeUnproved`).
   */
  readonly unproved?: string | undefined;
  /**
   * Handed the answer to it as the browser asks for it, in what it accepts at once
   * (`browserCodings`), once it came: what the browser keeps of it.
   */
  readonly answered?: ((answer: Reading) => void) | undefined;
}

/** The answer a part goes out with, by what Next.js marks it with: a segment, the postponed part. */
const POSTPONED_HEADER = 'x-nextjs-postponed';
const SEGMENT_POSTPONED = '2';
/** Where Next.js says a page's whole payload, or its props, came from: the cache, fresh or stale. */
export const CACHE_HEADER = 'x-nextjs-cache';
export const HIT = 'HIT';
export const STALE = 'STALE';
/** What a part from a runtime generation may be marked with: fresh, or stale. */
const RUNTIME_STATES = `${HIT} or ${STALE}`;
/** Where it says a part came from a render since the build's, which the build's bytes are not. */
export const PRERENDER_HEADER = 'x-nextjs-prerender';

/** A prefetch as far as the static part, which a postponed payload may answer (`answerPart`). */
const STATIC_PREFETCH: PrefetchKind = '1';

/** What an answer says of its own bytes, whatever the application sets (`ANSWER_ENTITY_HEADERS`). */
export const ANSWER_ENTITY: ReadonlySet<string> = new Set([
  'content-encoding',
  'content-length',
  'etag',
]);
/** A page's entity headers besides, which say nothing true of a part of it (`PAGE_ENTITY_HEADERS`). */
export const PAGE_ENTITY: ReadonlySet<string> = new Set([
  ...ANSWER_ENTITY,
  'content-type',
  'last-modified',
]);
/** What the edge sets on every part over whatever the application set (`segmentHeaders`). */
const EDGE_SETS: ReadonlySet<string> = new Set([
  ...ANSWER_ENTITY,
  'content-type',
  EDGE_HEADER,
  'x-arkor-edge-validated',
]);

/**
 * What the edge sets on a part over whatever the application set, by the marks it owns
 * (`generationHeaders`): where it came from the cache — a payload's or props', never a segment's;
 * that it is postponed — a segment's always, a runtime generation's payload's by whether it is; that
 * it was rendered since — a runtime generation's segment's or payload's. Any other the application
 * set goes out as set.
 */
export function edgeSetsOn(kind: PartKind, runtime: boolean): Set<string> {
  const owned = new Set<string>(EDGE_SETS);
  if (kind !== 'segment') {
    owned.add(CACHE_HEADER);
  }
  if (kind === 'segment' || (kind === 'payload' && runtime)) {
    owned.add(POSTPONED_HEADER);
  }
  if (runtime && kind !== 'data') {
    owned.add(PRERENDER_HEADER);
  }
  return owned;
}

/**
 * Why a payload the build wrote is marked postponed by other than the application: the edge marks
 * none (`generationHeaders`), so it goes out marked as the application set it or not at all — by
 * which the router would take the page's whole payload for one a resume finishes.
 */
export function unlaidPostponedFailure(
  answer: Reading,
  laid: Headers,
  judged: { readonly kind: PartKind; readonly runtime: boolean },
): string | undefined {
  const postponed = answer.headers[POSTPONED_HEADER];
  if (
    postponed === undefined ||
    judged.runtime ||
    judged.kind !== 'payload' ||
    laid.has(POSTPONED_HEADER)
  ) {
    return undefined;
  }
  return `answered with ${POSTPONED_HEADER} ${String(postponed)}, which nothing the application set marks the payload the build wrote with`;
}

/** What the edge marks a runtime generation's payload with that a resume would finish. */
const PAYLOAD_POSTPONED = '1';

/**
 * Why a prefetched payload of a runtime generation is not marked as the edge marks one: postponed
 * (`1`) where a resume would finish it, and not at all where it is whole (`generationHeaders`) —
 * nothing else, which the router would read otherwise.
 */
function prefetchedPostponedFailure(postponed: string | string[]): string | undefined {
  return postponed === PAYLOAD_POSTPONED
    ? undefined
    : `answered with ${POSTPONED_HEADER} ${String(postponed)}, not ${PAYLOAD_POSTPONED} or none`;
}

/**
 * Why a segment is not marked as Next.js marks one: as the postponed part of its page, and from the
 * cache by none but the application — neither Next.js nor the edge marks a segment so, and no
 * record keeps a mark of Next.js's (`filterStoredResponseHeaders`).
 */
function segmentMarkedFailure(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  cacheMarked: string | undefined,
): string | undefined {
  const postponed = headers[POSTPONED_HEADER];
  if (postponed !== SEGMENT_POSTPONED) {
    return `answered with ${POSTPONED_HEADER} ${String(postponed ?? 'none')}, not ${SEGMENT_POSTPONED}`;
  }
  const state = headers[CACHE_HEADER];
  return state === undefined || cacheMarked !== undefined
    ? undefined
    : `answered with ${CACHE_HEADER} ${String(state)}, which marks no segment`;
}

/**
 * Why a part is not marked as Next.js marks it: a segment as the postponed part of its page; a
 * page's whole payload, or its props, as from the cache — fresh, or stale where a runtime
 * generation answered it — and a runtime generation's payload as no postponed one.
 */
export function markedFailure(
  part: { readonly kind: PartKind; readonly prefetch?: PrefetchKind | undefined },
  headers: Readonly<Record<string, string | string[] | undefined>>,
  judged: {
    readonly runtime: boolean;
    /** What the application set the cache mark to on it, where it did (`setByApplication`). */
    readonly cacheMarked: string | undefined;
  },
): string | undefined {
  const { kind } = part;
  const { runtime } = judged;
  // Rendered since, as the edge marks every segment and payload of a runtime generation.
  const prerendered = headers[PRERENDER_HEADER];
  if (runtime && kind !== 'data' && prerendered !== '1') {
    return `answered with ${PRERENDER_HEADER} ${String(prerendered ?? 'none')}, not the 1 the edge marks a runtime generation's part with`;
  }
  if (kind === 'segment') {
    return segmentMarkedFailure(headers, judged.cacheMarked);
  }
  const postponed = headers[POSTPONED_HEADER];
  // A navigation's payload is whole: a runtime generation a resume would have to finish is the
  // Function's to answer (`answerPart`), and is marked postponed where the edge answers a prefetch.
  if (kind === 'payload' && runtime && postponed !== undefined) {
    const misplaced =
      part.prefetch === STATIC_PREFETCH
        ? prefetchedPostponedFailure(postponed)
        : `answered with ${POSTPONED_HEADER} ${String(postponed)}, a postponed payload, to a request that asks for a whole one`;
    if (misplaced !== undefined) {
      return misplaced;
    }
  }
  const state = headers[CACHE_HEADER];
  if (state === HIT || (runtime && state === STALE)) {
    return undefined;
  }
  const said = Array.isArray(state) ? state.join(', ') : (state ?? 'none');
  const marked = runtime ? RUNTIME_STATES : HIT;
  return `answered with ${CACHE_HEADER} ${said}, not ${marked}`;
}
