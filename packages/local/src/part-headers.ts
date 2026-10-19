import { evaluateFreshness } from '@stayingupwind/core/cache';
import type { ConfiguredHeaders } from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import {
  type CookieHostContext,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  SHARED_CACHE_CONTROL_HEADERS,
} from '@stayingupwind/core/request';
import { mergeScopedMiddlewareHeaders } from '@stayingupwind/edge/handlers/responses';
import { layStoredConfiguredOver } from '@stayingupwind/edge/internal/handlers/configured-headers';

import {
  type CheckedStack,
  configuredValue,
  cookieFailure,
  cookieScopeOf,
  recordedGenerationsOf,
} from './answers.ts';
import {
  ANSWER_ENTITY,
  CACHE_HEADER,
  edgeSetsOn,
  HIT,
  PAGE_ENTITY,
  type Part,
  type PartKind,
  STALE,
  unlaidPostponedFailure,
} from './part-marks.ts';
import type { Reading } from './reading.ts';
import { recordEntriesOf } from './recorded.ts';
import type { RecordedGeneration, RecordedOutput } from './workers/protocol.ts';

/**
 * What a part of a route carries of what its application set on it (`part-verdicts.ts`): the
 * headers its page was recorded with — by the build, or by the runtime generation that answered it —
 * what the rules of `next.config` set, and what the middleware set, as the edge lays each
 * (`segmentHeaders` in the edge).
 */

export const CACHE_CONTROL = 'cache-control';
export const CONTENT_ENCODING = 'content-encoding';
export const SET_COOKIE = 'set-cookie';
const VARY = 'vary';

/** `answer`'s value of `name`, its repeats joined. */
export function valueOf(answer: Reading, name: string): string | undefined {
  const value = answer.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** Whether `answer` varies by every name in `names`, or by everything (`*`). */
export function variesBy(answer: Reading, names: readonly string[]): string | undefined {
  const varied = new Set(
    (valueOf(answer, VARY) ?? '').split(',').map((name) => name.trim().toLowerCase()),
  );
  return varied.has('*') ? undefined : names.find((name) => !varied.has(name));
}

/**
 * What the application sets on a part, as the edge lays it (`applicationHeaders`): the headers the
 * page was recorded with (`recorded`) — but its entity headers and `Link` — then what the rules of
 * `next.config` set for the request, a cookie of either scoped as the edge scopes it
 * (`configuredValue`), then what the middleware set, as the edge merges it
 * (`mergeScopedMiddlewareHeaders`).
 */
function laidOn(
  part: Part,
  judged: {
    readonly configured: ConfiguredHeaders;
    readonly decided: MiddlewareResult | undefined;
    /** What the application recorded the part's page with, as the edge lays it on the part. */
    readonly recorded: Readonly<Record<string, string>>;
    /** How the stack's edge scopes a cookie it sends (`cookieScopeOf`). */
    readonly scope: CookieHostContext;
  },
): Headers {
  const leftBehind = part.kind === 'data' ? ANSWER_ENTITY : PAGE_ENTITY;
  const laid = new Headers();
  const recorded = Object.entries(judged.recorded);
  const set = (name: string, value: string): void => {
    const lower = name.toLowerCase();
    if (leftBehind.has(lower)) {
      return;
    }
    try {
      laid.set(lower, configuredValue(lower, value, judged.scope));
    } catch {
      // A name a rule made of a capture that no header can have: the edge sets none either.
    }
  };
  for (const [name, value] of recorded) {
    if (name.toLowerCase() !== 'link') {
      set(name, value);
    }
  }
  layStoredConfiguredOver(laid, judged.configured, judged.scope, leftBehind);
  if (judged.decided?.kind === 'continue') {
    mergeScopedMiddlewareHeaders(laid, judged.decided.responseHeaders, judged.scope);
  }
  return laid;
}

/** What the edge puts after a coded part's caching, that nothing between re-encodes it. */
const NO_TRANSFORM = 'no-transform';

/**
 * What the application's `value` of `name` goes out as on `answer`: as it was set — but a coded
 * part's `Cache-Control`, which the edge sends with `no-transform` after it, so that nothing between
 * re-encodes the bytes it stored coded (`segmentHeaders`).
 */
function sentAs(answer: Reading, name: string, value: string): string {
  return name === CACHE_CONTROL && valueOf(answer, CONTENT_ENCODING) !== undefined
    ? `${value}, ${NO_TRANSFORM}`
    : value;
}

/**
 * Why `answer` does not carry the `value` of `name` the application set: a `Vary` naming it all, among
 * the edge's own; any other header as it goes out (`sentAs`).
 */
function setFailure(answer: Reading, name: string, value: string): string | undefined {
  if (name === VARY) {
    const missing = variesBy(
      answer,
      value.split(',').map((each) => each.trim().toLowerCase()),
    );
    return missing === undefined
      ? undefined
      : `answered under no Vary naming ${missing}, which the application set`;
  }
  const said = valueOf(answer, name);
  const sent = sentAs(answer, name, value);
  if (said === sent) {
    return undefined;
  }
  const added = sent === value ? '' : `, ${NO_TRANSFORM} after it as the edge adds to a coded part`;
  return `answered with ${name} ${said ?? 'none'}, not the ${value} the application set${added}`;
}

/**
 * Why a part does not carry what the application set on it (`laidOn`): each header as it was set, but
 * those the edge sets over it (`EDGE_SETS`), and its caching where the answer is one visitor's; each
 * name a `Vary` it set names, among the edge's; a payload's postponed mark it set, and no other
 * (`unlaidPostponedFailure`); each cookie it set, and no other.
 */
function appliedFailure(
  answer: Reading,
  laid: Headers,
  judged: { readonly kind: PartKind; readonly visitors: boolean; readonly runtime: boolean },
): string | undefined {
  const { visitors } = judged;
  const owned = edgeSetsOn(judged.kind, judged.runtime);
  if (visitors) {
    owned.add(CACHE_CONTROL);
    for (const name of SHARED_CACHE_CONTROL_HEADERS) {
      owned.add(name);
    }
  }
  for (const [name, value] of laid) {
    const failure =
      name === SET_COOKIE || owned.has(name) ? undefined : setFailure(answer, name, value);
    if (failure !== undefined) {
      return failure;
    }
  }
  // A built payload's postponed mark as it was set, or none; and each cookie as it was set, and
  // none besides.
  return unlaidPostponedFailure(answer, laid, judged) ?? cookieFailure(answer, laid.getSetCookie());
}

/**
 * Each generation of a part's record the stack's edge read, oldest first (`recordedGenerationsOf`):
 * one of them served a part a runtime generation answered, which the part's answer says not which —
 * of the route's record, or of a member's own beside its class's, where the middleware left the
 * request (`recordEntriesOf`).
 */
async function generationsReadOf(
  stack: CheckedStack,
  part: Part,
  decided: MiddlewareResult | undefined,
): Promise<readonly RecordedGeneration[]> {
  const scopeId = stack.manifest.cache?.scopeId;
  if (scopeId === undefined) {
    return [];
  }
  const pathname = decided?.kind === 'continue' ? decided.url.pathname : part.url.pathname;
  const entries = await recordEntriesOf(stack, part.route, pathname);
  const read = await Promise.all(
    entries.map((entryId) => recordedGenerationsOf(stack, { scopeId, entryId })),
  );
  return read.flatMap((generations) =>
    [...generations].toSorted(([a], [b]) => a - b).map(([, generation]) => generation),
  );
}

/**
 * Which output of a generation a part is, as its record names it (`answerPart` in the edge): a
 * segment by its path, the page's whole payload, its props — each kept as it is (`identity`).
 */
function outputOf(part: Part): Pick<RecordedOutput, 'role' | 'representationKey'> {
  if (part.kind === 'segment') {
    const path = part.headers[NEXT_ROUTER_SEGMENT_PREFETCH_HEADER] ?? '';
    return { role: 'segment', representationKey: `segment:${path}` };
  }
  return part.kind === 'payload'
    ? { role: 'rsc', representationKey: 'rsc' }
    : { role: 'pages-data', representationKey: 'pages-data' };
}

/** The source of a generation a build wrote, whose parts the edge serves as the build's own. */
const BUILD_SOURCE = 'build';

/**
 * Whether a generation the runtime rendered holds `answer`'s bytes as the output `part` is
 * (`outputOf`): one a build wrote the edge serves a part of as the build's, or hands on stale, never
 * as a runtime generation's (`partGeneration` in the edge).
 */
function holds(generation: RecordedGeneration, part: Part, answer: Reading): boolean {
  if (generation.source === BUILD_SOURCE) {
    return false;
  }
  const { role, representationKey } = outputOf(part);
  return generation.artifacts.some((output) => {
    return (
      output.role === role &&
      output.representationKey === representationKey &&
      output.encoding === 'identity' &&
      output.sha256 === answer.sha256 &&
      output.byteLength === answer.length
    );
  });
}

/** What a part a runtime generation answered is marked with where a resume would finish it. */
const POSTPONED_HEADER = 'x-nextjs-postponed';
const PAYLOAD_POSTPONED = '1';
const STATIC_PREFETCH = '1';

/**
 * Why a runtime generation's payload is not marked as the edge marks one from `generation`
 * (`generationHeaders`, `answerPart`): one a resume would finish answers a prefetch down to the
 * loading boundary alone, marked postponed (`1`); one complete in itself, no request marked so.
 */
function postponedFailure(
  part: Part,
  answer: Reading,
  generation: RecordedGeneration,
): string | undefined {
  if (part.kind !== 'payload') {
    return undefined;
  }
  const postponed = answer.headers[POSTPONED_HEADER];
  if (!generation.partial) {
    return postponed === undefined
      ? undefined
      : `answered with ${POSTPONED_HEADER} ${String(postponed)} from a generation complete in itself`;
  }
  if (part.prefetch !== STATIC_PREFETCH) {
    return 'answered from a generation a resume would finish, to a request that asks for the page whole';
  }
  return postponed === PAYLOAD_POSTPONED
    ? undefined
    : `answered with ${POSTPONED_HEADER} ${String(postponed ?? 'none')} from a generation a resume would finish, not ${PAYLOAD_POSTPONED}`;
}

/** When a part was asked for and when it was answered, by the wall clock. */
export interface Within {
  readonly from: number;
  readonly to: number;
}

/**
 * How far either side of a request a generation's validity is judged within: what the edge's clock
 * and the check's may tell apart, a wall clock that steps by seconds among it.
 */
const CLOCK_LEEWAY_MS = 2000;

/**
 * Why a runtime generation's payload or props are not marked as the edge marks one from
 * `generation` (`generationHeaders` in the edge): `STALE` where it was stale as the edge read it,
 * judged as the edge judges it (`evaluateFreshness`) at each end of the request, and `HIT` else.
 * None for a segment, which the edge marks no such way, nor for a generation recorded with nothing
 * to judge it by.
 */
function cacheStateFailure(
  part: Part,
  answer: Reading,
  read: { readonly generation: RecordedGeneration; readonly within: Within | undefined },
): string | undefined {
  const { freshness } = read.generation;
  if (freshness === undefined || read.within === undefined || part.kind === 'segment') {
    return undefined;
  }
  const ends = [read.within.from - CLOCK_LEEWAY_MS, read.within.to + CLOCK_LEEWAY_MS];
  const states = new Set(
    ends.flatMap((now) => {
      const { validity } = evaluateFreshness({ ...freshness, now });
      if (validity === 'expired') {
        return [];
      }
      return [validity === 'stale' ? STALE : HIT];
    }),
  );
  const said = answer.headers[CACHE_HEADER];
  if (typeof said === 'string' && states.has(said)) {
    return undefined;
  }
  const marked = states.size === 0 ? 'nothing, as it had expired' : [...states].join(' or ');
  return `answered with ${CACHE_HEADER} ${String(said ?? 'none')}, though its generation's validity marks it ${marked}`;
}

/**
 * Why a part does not carry what the application set on it (`appliedFailure`), with the headers the
 * application recorded the part's page with as the edge lays them (`routeHeaders` in the edge): a
 * part of the page the build wrote, the route's; a page's props, none. A runtime generation's part
 * has to be the output of one the stack's edge read of the route's record (`generationsReadOf`) —
 * its bytes, as that output — marked postponed as that generation is partial (`postponedFailure`),
 * and carry the headers it was recorded with: as one that holds it does, or failing as the newest.
 */
export async function recordedAppliedFailure(
  stack: CheckedStack,
  part: Part,
  read: {
    readonly answer: Reading;
    readonly configured: ConfiguredHeaders;
    readonly decided: MiddlewareResult | undefined;
    readonly visitors: boolean;
    readonly runtime: boolean;
    /** When it was asked for and answered, which a runtime generation's validity is judged at. */
    readonly within?: Within | undefined;
  },
): Promise<string | undefined> {
  const { answer, configured, decided } = read;
  const judged = { kind: part.kind, visitors: read.visitors, runtime: read.runtime };
  const scope = cookieScopeOf(stack);
  const recordedOf = (headers: Readonly<Record<string, string>>): Headers =>
    laidOn(part, { configured, decided, recorded: part.kind === 'data' ? {} : headers, scope });
  if (!read.runtime) {
    return appliedFailure(answer, recordedOf(part.route.headers), judged);
  }
  const generations = await generationsReadOf(stack, part, decided);
  const holding = generations.filter((generation) => holds(generation, part, answer));
  let failure =
    generations.length === 0
      ? "answered as a runtime generation's, though the stack's edge read no generation of its route's record"
      : `answered ${answer.length} bytes no generation of its route's record the stack's edge read holds for it`;
  for (const generation of holding) {
    const applied =
      postponedFailure(part, answer, generation) ??
      cacheStateFailure(part, answer, { generation, within: read.within }) ??
      appliedFailure(answer, recordedOf(generation.headers), judged);
    if (applied === undefined) {
      return undefined;
    }
    failure = applied;
  }
  return failure;
}
