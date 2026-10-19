import { headerRulesFor, type StaticFileEntry } from '@stayingupwind/core/manifest';

import { type CheckedStack, HTTP_OK } from './answers.ts';
import { askedAgain, opaqueTag, said, subjectOf } from './asked-again.ts';
import { carryingEach, lackingEach } from './escaping.ts';
import {
  describedFailure,
  expectationOf,
  fileFailure,
  fileHeadFailure,
} from './file-expectations.ts';
import {
  rangeFailure,
  rangeFormsFailure,
  resumedRangeFailure,
  staleRangeFailure,
} from './ranges.ts';
import type { Reading } from './reading.ts';
import { routedReads } from './routing-reads.ts';

/** The status of an answer to a request on a validator its holder already has. */
const NOT_MODIFIED_STATUS = 304;

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
  if (answer.status !== NOT_MODIFIED_STATUS) {
    return said(subject, `answered ${condition} with ${answer.status}, not ${NOT_MODIFIED_STATUS}`);
  }
  if (answer.headers.etag !== expected.etag) {
    return said(
      subject,
      `answered ${condition} under the entity tag ${answer.headers.etag ?? 'none'}`,
    );
  }
  if (answer.length > 0) {
    return said(subject, `answered ${condition} with a body`);
  }
  const described = describedFailure(answer, expected, true);
  return said(
    subject,
    described === undefined ? undefined : `asked for on ${condition}, ${described}`,
  );
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

/**
 * The requests a file at `url` is asked for again by, one for each rule of `next.config` that sets
 * its type on some requests alone — those carrying a cookie, a header or a query parameter the
 * request it was asked by does not, or lacking one it does — that does not hold for that request:
 * the request that carries what the rule asks for (`carryingEach`) and lacks what it says is
 * missing (`lackingEach`), where the check can make one it holds for. A browser that carries that
 * cookie, or a client that sends no `Accept`, is served the file under the rule's type.
 */
function typedRequestsOf(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
): { readonly headers: Record<string, string>; readonly url: URL; readonly what: string }[] {
  const typed: {
    readonly headers: Record<string, string>;
    readonly url: URL;
    readonly what: string;
  }[] = [];
  const { headerRules } = stack.manifest;
  if (headerRules === undefined) {
    return typed;
  }
  for (const rule of headerRules) {
    const alone = { ...stack.manifest, headerRules: [rule] };
    const typedBy = (headers: Readonly<Record<string, string>>, at: URL): boolean =>
      typeSetIn(headerRulesFor(alone, at, routedReads(at, headers)).headers) !== undefined;
    const conditioned = rule.has !== undefined || rule.missing !== undefined;
    if (!conditioned || typeSetIn(rule.headers) === undefined || typedBy(sent, url)) {
      continue;
    }
    // Carrying what the rule asks for, and lacking what it says is missing.
    const carried = carryingEach(sent, url, rule.has ?? []);
    const made = carried === undefined ? undefined : lackingEach(carried, rule.missing ?? []);
    if (carried !== undefined && made !== undefined && typedBy(made.headers, made.url)) {
      const asked = [carried.carried, made.lacked].filter((part) => part !== '').join(', ');
      typed.push({
        headers: { ...made.headers },
        url: made.url,
        what: `the request a rule of next.config types it for (${asked || 'as it was asked'})`,
      });
    }
  }
  return typed;
}

/**
 * Why a file the edge answers as itself, asked for by a request a rule of `next.config` sets its
 * type for alone (`typedRequestsOf`), is not answered as the edge answers that request: the file,
 * whole, under the type the rules give it for that request — the rule's, or a later one's.
 */
async function typedFailure(
  stack: CheckedStack,
  url: URL,
  asked: {
    readonly file: StaticFileEntry;
    readonly headers: Readonly<Record<string, string>>;
    readonly head: Buffer;
  },
): Promise<string | undefined> {
  const typedRequests = typedRequestsOf(stack, url, asked.headers);
  for (const typed of typedRequests) {
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
    const failure = fileFailure(subject.file, again.answer, expected);
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
 * and as each rule of `next.config` that sets its type for some requests alone serves it to them.
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
    (await typedFailure(stack, url, again))
  );
}
