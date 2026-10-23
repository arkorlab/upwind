import type { StaticFileEntry } from '@stayingupwind/core/manifest';
import { listsTag } from '@stayingupwind/edge/internal/strategies/entity-tags.ts';

import { type CheckedStack, HTTP_OK } from './answers.ts';
import { askedAgain, opaqueTag, said, type Subject, subjectOf } from './asked-again.ts';
import { type ByteRange, requestedRange } from './byte-ranges.ts';
import {
  describedFailure,
  expectationOf,
  type FileExpectation,
  fileFailure,
  fileHeadFailure,
} from './file-expectations.ts';
import { httpDateMs } from './http-dates.ts';
import {
  rangeFailure,
  rangeFormsFailure,
  resumedRangeFailure,
  selectedRangeFailure,
  staleRangeFailure,
  unsatisfiedFailure,
} from './ranges.ts';
import type { Reading } from './reading.ts';
import { requestsForRules, type RuleRequests } from './rule-witnesses.ts';

/** The status of an answer to a request on a validator its holder already has. */
const NOT_MODIFIED_STATUS = 304;
/** The status of an answer to a request on a precondition the file fails. */
const PRECONDITION_FAILED_STATUS = 412;

/**
 * A file the edge answered from storage, asked for again as a browser asks for one it already has
 * some of (`files.ts`): a range of it, on the entity tag it was served under, and for its headers
 * alone — each a request of its own to the application's routing (`askedAgain`), answered as the
 * file it asked for, or as the other file the middleware rewrote that request onto.
 */

/** Whether two entity tags name one entity, compared weakly as a `304` is decided (RFC 9110). */
function sameEntity(one: string, other: string): boolean {
  return opaqueTag(one) === opaqueTag(other);
}

/**
 * Why a file the edge answers as itself, asked for on the entity tag it was served under (`If-None-
 * Match`), as a browser revalidates a file it keeps, is not answered as one the browser already
 * has: `304`, under the same tag, with no body — and with what the whole file is answered with,
 * as the edge answers one from the manifest (`metadataResponse`): a browser updates what it holds
 * by each header the answer carries, and sets each cookie it carries. Only what describes the bytes
 * it does not send — their type, their coding — it may leave unsaid (`describedFailure`). Where the
 * request's own answer would carry another tag — the middleware's for it, or another file's the
 * middleware rewrote it onto — the validator matches nothing the edge would send, and the whole
 * file is the answer (`fileFailure`), as it is of a file of an error's status, whatever it carries.
 */
async function conditionalFailure(
  stack: CheckedStack,
  url: URL,
  asked: {
    readonly file: StaticFileEntry;
    readonly headers: Readonly<Record<string, string>>;
    readonly head: Buffer;
    readonly etag: string;
  },
): Promise<string | undefined> {
  const { etag } = asked;
  const condition = `If-None-Match ${etag}`;
  const sent = { ...asked.headers, 'if-none-match': etag };
  const again = await askedAgain(stack, url, { sent, what: condition });
  if (again.kind !== 'answered') {
    return again.kind === 'failed' ? again.reason : undefined;
  }
  const subject = subjectOf(stack, again, asked);
  const { answer } = again;
  // Under the tag the request's own answer would carry, which the edge compares the validator
  // with (`unmodified`): a file of an error's status is answered whole whatever it carries.
  const expected = expectationOf(stack, url, subject.file, { ...again, headers: sent });
  if ((subject.file.status ?? HTTP_OK) !== HTTP_OK || !sameEntity(expected.etag, etag)) {
    const whole = fileFailure(subject.file, answer, expected);
    return said(subject, whole === undefined ? undefined : `asked for on ${condition}, ${whole}`);
  }
  return said(subject, notModifiedFailure(answer, expected, condition));
}

/**
 * Why a file's answer to a request on a validator it holds (`condition`) is not one the browser
 * already has the file by: `304`, under the same tag, with no body — and what the whole file says
 * of itself, but for what describes the bytes it does not send (`describedFailure`).
 */
function notModifiedFailure(
  answer: Reading,
  expected: FileExpectation,
  condition: string,
): string | undefined {
  if (answer.status !== NOT_MODIFIED_STATUS) {
    return `answered ${condition} with ${answer.status}, not ${NOT_MODIFIED_STATUS}`;
  }
  if (answer.headers.etag !== expected.etag) {
    return `answered ${condition} under the entity tag ${answer.headers.etag ?? 'none'}`;
  }
  if (answer.length > 0) {
    return `answered ${condition} with a body`;
  }
  const described = describedFailure(answer, expected, true);
  return described === undefined ? undefined : `asked for on ${condition}, ${described}`;
}

/**
 * Why a file's answer to a request on a precondition it fails is not the edge's
 * (`preconditionFailure`): `412`, with no body, under what the whole file says of itself — kept by
 * nobody, as the edge keeps a refusal no cache keyed on the URL alone may hand on.
 */
function preconditionFailedFailure(answer: Reading, expected: FileExpectation): string | undefined {
  if (answer.status !== PRECONDITION_FAILED_STATUS) {
    return `answered ${answer.status}, not ${PRECONDITION_FAILED_STATUS}`;
  }
  if (answer.length > 0) {
    return `answered ${PRECONDITION_FAILED_STATUS} with a body`;
  }
  return describedFailure(answer, { ...expected, holding: { kind: 'nobody' } }, false);
}

/** What a request's conditions select of a file (`selectedBy`). */
type Selection =
  | { readonly kind: 'whole' | 'precondition-failed' }
  | { readonly kind: 'not-modified'; readonly condition: string }
  | { readonly kind: 'range'; readonly what: string; readonly range: ByteRange }
  | { readonly kind: 'unsatisfied'; readonly what: string };
const WHOLE: Selection = { kind: 'whole' };
const PRECONDITION_FAILED: Selection = { kind: 'precondition-failed' };

/** The file the client holds, as `condition` says. */
function notModified(condition: string): Selection {
  return { kind: 'not-modified', condition };
}

/** An HTTP-date's instant, read as the edge reads one (`httpDateMs`); none for no such date. */
function instantOf(value: string | null): number | undefined {
  return value === null ? undefined : httpDateMs(value);
}

/**
 * What the edge answers a request for a file with by the conditions it carries, judged against the
 * answer the file would be given — the tag it carries, and the `Last-Modified` a rule or the
 * middleware gave it, storage keeping no date of a file's own — in the order the edge judges them
 * (`metadataResponse` in its handler for files): a precondition the file fails first — an `If-Match`
 * naming another entity, or, asked without one, an `If-Unmodified-Since` earlier than its date —
 * answered `412`; then a validator the client holds — an `If-None-Match` naming its tag, or, asked
 * without one, an `If-Modified-Since` no earlier than its date — answered `304` (`condition` says
 * which); then a range it asks (`rangeSelected`); the file, whole, otherwise. A file of another
 * status than 200 is judged by none of them
 * (`answersAsItself`). The edge's judgement is mirrored here, not called, and so is its reading of a
 * date (`httpDateMs`); a list of tags is read with the edge's own reader (`listsTag`), a leaf of no
 * import.
 */
function selectedBy(
  file: StaticFileEntry,
  sent: Readonly<Record<string, string>>,
  expected: FileExpectation,
): Selection {
  if ((file.status ?? HTTP_OK) !== HTTP_OK) {
    return WHOLE;
  }
  const headers = new Headers(sent);
  const modified = instantOf(expected.set.get('last-modified'));
  const ifMatch = headers.get('if-match');
  const unmodifiedSince = instantOf(headers.get('if-unmodified-since'));
  const fails =
    ifMatch === null || ifMatch === ''
      ? unmodifiedSince !== undefined && modified !== undefined && modified > unmodifiedSince
      : !listsTag(ifMatch, expected.etag);
  if (fails) {
    return PRECONDITION_FAILED;
  }
  const ifNoneMatch = headers.get('if-none-match');
  if (ifNoneMatch === null) {
    const ifModifiedSince = headers.get('if-modified-since');
    const since = instantOf(ifModifiedSince);
    if (since !== undefined && modified !== undefined && modified <= since) {
      return notModified(`If-Modified-Since ${String(ifModifiedSince)}`);
    }
  } else if (listsTag(ifNoneMatch, expected.etag)) {
    return notModified(`If-None-Match ${ifNoneMatch}`);
  }
  return rangeSelected(file, headers, expected);
}

/**
 * What a range the request carries selects of the file, as the edge reads one (`requestedRange`):
 * the part it names, `416` for one no byte of the file satisfies, and the whole file for none it can
 * answer as one range (Codex).
 */
function rangeSelected(
  file: StaticFileEntry,
  headers: Headers,
  expected: FileExpectation,
): Selection {
  const value = headers.get('range');
  const range = requestedRange(headers, expected.etag, file.byteLength);
  if (value === null || range === undefined) {
    return WHOLE;
  }
  const what = `Range ${value}`;
  return range === null ? { kind: 'unsatisfied', what } : { kind: 'range', what, range };
}

/**
 * Why a file asked for by a request a rule of `next.config` sets headers on it for is not answered as
 * the edge answers that request: by the conditions the request carries — which a rule conditioned on one has
 * it carry (Codex) — `412` for a precondition the file fails, `304` for a validator the client
 * holds, `206` for a range it names and `416` for one no byte satisfies, and the file, whole,
 * otherwise (`selectedBy`).
 */
function selectedFailure(
  stack: CheckedStack,
  subject: Subject,
  answer: Reading,
  read: { readonly sent: Readonly<Record<string, string>>; readonly expected: FileExpectation },
): string | undefined {
  const { file } = subject;
  const selected = selectedBy(file, read.sent, read.expected);
  switch (selected.kind) {
    case 'precondition-failed': {
      return preconditionFailedFailure(answer, read.expected);
    }
    case 'not-modified': {
      return notModifiedFailure(answer, read.expected, selected.condition);
    }
    case 'range': {
      const { what, range } = selected;
      return selectedRangeFailure(stack, subject, { answer, what, range, expected: read.expected });
    }
    case 'unsatisfied': {
      return unsatisfiedFailure(selected.what, { file, answer, expected: read.expected });
    }
    case 'whole': {
      return fileFailure(file, answer, read.expected);
    }
  }
}

/**
 * Why a file the edge answers as itself, asked for its headers alone (`HEAD`), as a download
 * manager or a link checker asks, is not answered as the whole file it serves for the request is —
 * the edge answers one from the manifest rather than storage (`metadataResponse`) — with no body,
 * and the file's length.
 */
async function headFailure(
  stack: CheckedStack,
  url: URL,
  asked: {
    readonly file: StaticFileEntry;
    readonly headers: Readonly<Record<string, string>>;
    readonly head: Buffer;
  },
): Promise<string | undefined> {
  const { headers } = asked;
  const again = await askedAgain(stack, url, {
    sent: headers,
    what: 'its headers',
    method: 'HEAD',
  });
  if (again.kind !== 'answered') {
    return again.kind === 'failed' ? again.reason : undefined;
  }
  const subject = subjectOf(stack, again, asked);
  const { file } = subject;
  const expected = expectationOf(stack, url, file, { ...again, headers });
  return said(subject, fileHeadFailure(file, again.answer, expected));
}

/** The header a rule of `next.config` sets a file's type by. */
const CONTENT_TYPE = 'content-type';

/** The type a rule of `next.config` sets, of the headers it sets (`headerRulesFor`). */
function typeSetIn(headers: Readonly<Record<string, string>>): string | undefined {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === CONTENT_TYPE)?.[1];
}

/** What a rule of `next.config` is said to do of a file, by what it sets: its type, or other headers. */
function whatRuleDoes(headers: Readonly<Record<string, string>>): string {
  return typeSetIn(headers) === undefined ? 'sets headers on it for' : 'types it for';
}

/**
 * The requests a file at `url` is asked for again by, one for each rule of `next.config` that sets
 * headers on it for some requests alone — its type, or any other header (Codex): a download's
 * `Content-Disposition` on a query parameter, say — those carrying a cookie, a header or a query
 * parameter the request it was asked by does not, or lacking one it does — that does not hold for
 * that request: the request that carries what the rule asks for (`carryingEach`) and lacks what it
 * says is missing (`lackingEach`), where the check can make one it holds for. A browser that
 * carries that cookie, or a client that sends no `Accept`, is served the file under what the rule
 * sets — as many as the rules that apply to it, no more.
 */
function ruleRequestsOf(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
): RuleRequests {
  const result = requestsForRules(stack, url, sent, stack.manifest.headerRules ?? []);
  return {
    ...result,
    requests: result.requests.map((request) => {
      return {
        ...request,
        what: `the request a rule of next.config ${whatRuleDoes(request.rule.headers)} (${request.what})`,
      };
    }),
  };
}

/**
 * Why a file the edge answers as itself, asked for by a request a rule of `next.config` sets headers
 * on it for alone (`ruleRequestsOf`), is not answered as the edge answers that request: the file,
 * whole, under the type and the headers the rules give it for that request — the rule's, or a later
 * one's (`expectationOf`) — or what the conditions that request carries select of it
 * (`selectedFailure`).
 */
async function ruleFailure(
  stack: CheckedStack,
  url: URL,
  asked: {
    readonly file: StaticFileEntry;
    readonly headers: Readonly<Record<string, string>>;
    readonly head: Buffer;
  },
): Promise<string | undefined> {
  const { requests: ruleRequests, unproved } = ruleRequestsOf(stack, url, asked.headers);
  if (unproved !== undefined) return unproved;
  for (const typed of ruleRequests) {
    const again = await askedAgain(stack, typed.url, { sent: typed.headers, what: typed.what });
    if (again.kind === 'failed') {
      return again.reason;
    }
    if (again.kind !== 'answered') {
      continue;
    }
    const subject = subjectOf(stack, again, asked);
    const expected = expectationOf(stack, typed.url, subject.file, {
      ...again,
      headers: typed.headers,
    });
    const failure = selectedFailure(stack, subject, again.answer, {
      sent: typed.headers,
      expected,
    });
    if (failure !== undefined) {
      return said(subject, `asked for as ${typed.what}, ${failure}`);
    }
  }
  return undefined;
}

/**
 * Why a file the edge answered from storage, as itself, is not answered as the edge answers each
 * request a browser makes of it again: a range of it, and one on its own tag and on a stale one
 * (`If-Range`), on its entity tag, for its headers alone —
 * and as each rule of `next.config` that sets headers on it for some requests alone serves it to them.
 */
export async function followUpFailure(
  stack: CheckedStack,
  url: URL,
  asked: {
    readonly file: StaticFileEntry;
    readonly headers: Readonly<Record<string, string>>;
    /** The whole file, as answered: its first bytes, by their digest the file's own. */
    readonly answer: Reading;
    /** The entity tag it was served under, which a browser revalidates it on. */
    readonly etag: string;
  },
): Promise<string | undefined> {
  const { file, headers, answer, etag } = asked;
  const again = { file, headers, head: answer.head };
  return (
    (await rangeFailure(stack, url, { file, headers, answer })) ??
    (await resumedRangeFailure(stack, url, { file, headers, answer, etag })) ??
    (await staleRangeFailure(stack, url, { ...again, etag })) ??
    (await rangeFormsFailure(stack, url, { file, headers, answer })) ??
    (await conditionalFailure(stack, url, { ...again, etag })) ??
    (await headFailure(stack, url, again)) ??
    (await ruleFailure(stack, url, again))
  );
}
