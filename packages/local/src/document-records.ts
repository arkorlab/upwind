import type { RouteEntry } from '@stayingupwind/core/manifest';
import { isHtmlContentType } from '@stayingupwind/core/util';

import {
  answeredBy,
  type CheckedStack,
  EDGE_HEADER,
  failed,
  failureStatus,
  type Kept,
  keptFailure,
  middlewareCovers,
  recordedGenerationsOf,
  skipped,
  unrunFailure,
  type Verdict,
  withGenerationEvidence,
} from './answers.ts';
import { sharedCacheFailure } from './cache-control.ts';
import { type Accepted, codingFailure } from './codings.ts';
import { incompleteness } from './completeness.ts';
import { landingOf } from './landings.ts';
import type { Reading } from './reading.ts';
import {
  recordEntriesOf,
  servedGeneration,
  servedWhole,
  type ServedGeneration,
} from './recorded.ts';
import type { RecordedGeneration } from './workers/protocol.ts';

/** The two document decisions that hand a `HEAD` to the Function. */
export const HEAD_HANDED_ON = /^passthrough;reason=head-(resumed|expired)(?:;|$)/u;
/** What the edge says of a page it hands on for its record's status (`decideRecord`): the status. */
const RECORD_STATUS = /^passthrough;reason=generation-status-(\d+)(?:;|$)/u;
/** What a render answers a page a refresh found deleted with (`notFound()`), and records it as. */
const NOT_FOUND_STATUS = 404;

/** Only records this `HEAD` observed, for its routed class or eligible member. */
async function headGenerations(
  stack: CheckedStack,
  route: RouteEntry,
  pathname: string,
  served?: ServedGeneration,
): Promise<readonly RecordedGeneration[]> {
  const scopeId = stack.manifest.cache?.scopeId;
  if (scopeId === undefined || stack.generationEvidence === undefined) return [];
  const entries = (await recordEntriesOf(stack, route, pathname)).filter(
    (entryId) => served === undefined || (entryId !== route.cache?.entryId) === served.member,
  );
  const records = await Promise.all(
    entries.map((entryId) => recordedGenerationsOf(stack, { scopeId, entryId })),
  );
  return records.flatMap((generations) => {
    if (served === undefined) {
      return [...generations].flatMap(([seq, generation]) =>
        Number.isSafeInteger(seq) && seq > 0 ? [generation] : [],
      );
    }
    const generation = generations.get(served.seq);
    return generation === undefined ? [] : [generation];
  });
}

/** Check the claimed handoff against this request's record evidence, never an earlier `GET`. */
export async function headRecordHandoffFailure(
  stack: CheckedStack,
  route: RouteEntry,
  pathname: string,
  answered: string,
): Promise<string | undefined> {
  const generations = await headGenerations(stack, route, pathname);
  if (HEAD_HANDED_ON.exec(answered)?.[1] === 'expired') {
    // The edge also expires locally condemned records. The trace proves the record read, not
    // that unrecorded decision or its instant; do not infer it from the stored freshness alone.
    return generations.length > 0
      ? undefined
      : 'handed on as expired, though this HEAD read none of its applicable records';
  }
  if (generations.length > 0) {
    return generations.some((generation) => generation.partial)
      ? undefined
      : 'handed on for a resume, though this HEAD read only complete generations';
  }
  return route.cache?.delivery === 'complete'
    ? 'handed on for a resume, though its build finished it and this HEAD read no partial generation'
    : undefined;
}

/** The same record checks where this `HEAD`'s middleware moved it to another route. */
export async function headLandingHandoffFailure(
  stack: CheckedStack,
  landed: RouteEntry | undefined,
  read: { readonly pathname: string; readonly answered: string; readonly done: string },
): Promise<string | undefined> {
  const { answered, done } = read;
  if (landed !== undefined && HEAD_HANDED_ON.test(answered)) {
    const failure = await headRecordHandoffFailure(stack, landed, read.pathname, answered);
    return failure === undefined
      ? undefined
      : `${done} the route ${landed.pathname}, and ${failure}`;
  }
  return landed?.cache?.delivery === 'complete'
    ? `${done} the route ${landed.pathname}, and not answered from its shell (${EDGE_HEADER}: ${answered})`
    : undefined;
}

/** A shell `HEAD` must be whole in its own build or selected generation. */
export async function wholeHeadFailure(
  stack: CheckedStack,
  route: RouteEntry,
  pathname: string,
  answer: Reading,
): Promise<string | undefined> {
  if (!servedWhole(answeredBy(answer))) return 'answered from a shell a resume still completes';
  const served = servedGeneration(answer, route);
  if (served === undefined) {
    return route.cache?.delivery === 'complete'
      ? undefined
      : 'answered whole from a build shell a resume still completes';
  }
  const generations = await headGenerations(stack, route, pathname, served);
  if (generations.length === 0) {
    return 'answered whole from a generation this HEAD did not read';
  }
  return generations.some((generation) => generation.partial)
    ? 'answered whole from a generation this HEAD read as partial'
    : undefined;
}

/**
 * Why a page the edge regenerated in the foreground is not the route's: the Function's render, not
 * the build's shell, so held to being a whole HTML document of the route's status — or of a page the
 * render found deleted (404), which the runtime records as the page's status from then on (greptile)
 * — and kept from shared caches whatever it said, as the edge hands any answer on
 * (`privateCacheControl`).
 */
export function regeneratedFailure(
  route: RouteEntry,
  answer: Reading,
  coding: Accepted | undefined,
): string | undefined {
  if (answer.status !== route.status && answer.status !== NOT_FOUND_STATUS) {
    return `answered ${answer.status}`;
  }
  const type = answer.headers['content-type'];
  if (!isHtmlContentType(type ?? null)) {
    return `answered as ${type ?? 'no type'}, not an HTML document`;
  }
  return (
    codingFailure(answer, { coding, agent: undefined }, false) ??
    incompleteness(answer) ??
    sharedCacheFailure(answer, () => false)
  );
}

/** Whether this request read a generation of the route's record, its own or its member's, of `status`. */
async function readOfStatus(
  stack: CheckedStack,
  route: RouteEntry,
  read: { readonly pathname: string; readonly status: number },
): Promise<boolean> {
  const scopeId = stack.manifest.cache?.scopeId;
  if (scopeId === undefined) return false;
  const entries = await recordEntriesOf(stack, route, read.pathname);
  const records = await Promise.all(
    entries.map((entryId) => recordedGenerationsOf(stack, { scopeId, entryId })),
  );
  for (const generations of records) {
    for (const generation of generations.values()) {
      if (generation.status === read.status) return true;
    }
  }
  return false;
}

/**
 * A page the edge handed on for its record's status (`generation-status-<status>`): a render since the
 * build answered other than 200 — a page a refresh found deleted, 404 — and the edge leaves the page to
 * the Function, which answers it from the runtime's cache (`decideRecord`). Judged against the records
 * this request read, not the build's 200 (greptile): the application's, where one of the route's
 * record — the route asked for, or the one the middleware moved it onto — has that status. The record
 * is read behind the middleware, as a regeneration is, so one the build's matchers cover is handed on
 * with a decision kept. Nothing for any other answer.
 */
export async function recordStatusVerdict(
  stack: CheckedStack,
  asked: {
    readonly requested: string;
    readonly route: RouteEntry;
    readonly headers: Readonly<Record<string, string>>;
  },
  read: { readonly kept: () => Promise<Kept>; readonly answer: Reading; readonly answered: string },
): Promise<Verdict | undefined> {
  const said = RECORD_STATUS.exec(read.answered)?.[1];
  if (said === undefined) {
    return undefined;
  }
  const status = Number(said);
  const url = new URL(asked.requested, stack.site);
  const kept = await read.kept();
  const { decided } = kept;
  const covered = middlewareCovers(stack, url, asked.headers);
  const unkept =
    keptFailure(read.answer, decided) ??
    unrunFailure(decided, covered, "handed it on for its record's status");
  if (unkept !== undefined) {
    return failed(unkept);
  }
  const moved = decided?.kind === 'continue';
  const route = moved ? landingOf(stack, decided.url, decided) : asked.route;
  const pathname = moved ? decided.url.pathname : url.pathname;
  const recorded =
    route !== undefined &&
    (await readOfStatus(withGenerationEvidence(stack, kept), route, { pathname, status }));
  if (!recorded) {
    return failed(
      `handed on for a record of status ${String(status)}, though this request read no generation of its record with it`,
    );
  }
  // The Function's answer, and its to give: but not a failure of its own, whatever the record says
  // (`failureStatus`, Codex), as a Pages handoff is held (`pagesHandoffVerdict`).
  const unhealthy = failureStatus(read.answer);
  return unhealthy === undefined
    ? skipped(
        `the application's: a render since the build answered it ${String(status)}, which the Function answers`,
      )
    : failed(unhealthy);
}
