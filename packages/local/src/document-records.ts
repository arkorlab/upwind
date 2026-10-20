import type { RouteEntry } from '@stayingupwind/core/manifest';
import { isHtmlContentType } from '@stayingupwind/core/util';

import { answeredBy, type CheckedStack, EDGE_HEADER, recordedGenerationsOf } from './answers.ts';
import { sharedCacheFailure } from './cache-control.ts';
import { type Accepted, codingFailure } from './codings.ts';
import { incompleteness } from './completeness.ts';
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
  return generations.some((generation) => generation.partial)
    ? 'answered whole from a generation this HEAD read as partial'
    : undefined;
}

/**
 * Why a page the edge regenerated in the foreground is not the route's: the Function's render, not
 * the build's shell, so held to being a whole HTML document of the route's status — and kept from
 * shared caches whatever it said, as the edge hands any answer on (`privateCacheControl`).
 */
export function regeneratedFailure(
  route: RouteEntry,
  answer: Reading,
  coding: Accepted | undefined,
): string | undefined {
  if (answer.status !== route.status) {
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
