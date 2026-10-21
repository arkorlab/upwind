import type { StaticFileEntry } from '@stayingupwind/core/manifest';

import { type CheckedStack, HTTP_OK } from './answers.ts';
import {
  askedAgain,
  type AskedAgain,
  blobBytesAt,
  opaqueTag,
  RANGE_BYTES,
  said,
  type Subject,
  subjectOf,
} from './asked-again.ts';
import { describedFailure, expectationOf, fileFailure } from './file-expectations.ts';
import { rangeDigestOf } from './range-digests.ts';
import type { Reading } from './reading.ts';

/**
 * A file the edge answered from storage, asked for again in part (`follow-ups.ts`): a range of it as
 * a resumed download asks (`bytes=1-<end>`), on the tag it is served under and on a stale one
 * (`If-Range`), from its end (`bytes=-<n>`) and from a byte on (`bytes=1-`), each held to what the
 * edge answers it with (`requestedRange`).
 */

const PARTIAL_CONTENT_STATUS = 206;
/** The status of an answer to a range no byte of the file satisfies. */
const RANGE_NOT_SATISFIABLE_STATUS = 416;

/**
 * Why a range no byte of a file satisfies (`partFailure`) is not answered as the edge answers one
 * (`rangeNotSatisfiable`): `416`, its `Content-Range` naming the file's length and no range of it,
 * with no body, and with the whole file's headers but its length — its type, its tag, every header
 * the application set and its cookies — kept by nobody, whatever the file is kept for: a cache
 * keyed on the URL alone would hand the 416 to every request for the file.
 */
function unsatisfiedFailure(
  range: string,
  read: {
    readonly file: StaticFileEntry;
    readonly answer: Reading;
    readonly expected: ReturnType<typeof expectationOf>;
  },
): string | undefined {
  const { file, answer } = read;
  const unsatisfied = `bytes */${file.byteLength}`;
  if (
    answer.status !== RANGE_NOT_SATISFIABLE_STATUS ||
    answer.headers['content-range'] !== unsatisfied
  ) {
    return `answered ${range} with ${answer.status}, not ${RANGE_NOT_SATISFIABLE_STATUS} under Content-Range ${unsatisfied}`;
  }
  if (answer.length > 0) {
    return `answered ${range} with a body, though no byte of the file satisfies it`;
  }
  const unkept = { ...read.expected, holding: { kind: 'nobody' } } as const;
  const described = describedFailure(answer, unkept, false);
  return described === undefined ? undefined : `asked for ${range}, ${described}`;
}

/**
 * Why a range of a file the edge answers as itself (`bytes=1-<end>`), as a resumed download or a
 * media player asks for one, is not answered as the edge answers it of the file it serves: its
 * bytes, served as a range (`206`, `Content-Range`, the range's own `Content-Length`) with the whole
 * file's headers; a file no byte past its first satisfies the range of, `416`; and one of an
 * error's status, which answers no range, whole.
 */
function partFailure(
  stack: CheckedStack,
  url: URL,
  read: {
    readonly subject: Subject;
    readonly again: Extract<AskedAgain, { kind: 'answered' }>;
    readonly sent: Readonly<Record<string, string>>;
    readonly end: number;
    /** The range asked for, and the validator it was asked on, in a verdict's words. */
    readonly what: string;
  },
): string | undefined {
  const { subject, again, sent } = read;
  const { file } = subject;
  const { answer } = again;
  const range = read.what;
  // As the request for the range selects the rules, as the edge applies them to it.
  const expected = expectationOf(stack, url, file, { ...again, headers: sent });
  if ((file.status ?? HTTP_OK) !== HTTP_OK || !resumesOn(sent, expected.etag)) {
    const whole = fileFailure(file, answer, expected);
    return whole === undefined ? undefined : `asked for ${range}, ${whole}`;
  }
  if (file.byteLength < 2) {
    return unsatisfiedFailure(range, { file, answer, expected });
  }
  if (answer.status !== PARTIAL_CONTENT_STATUS) {
    return `answered ${range} with ${answer.status}, not ${PARTIAL_CONTENT_STATUS}`;
  }
  const end = Math.min(read.end, file.byteLength - 1);
  const named = `bytes 1-${end}/${file.byteLength}`;
  const contentRange = answer.headers['content-range'];
  if (contentRange !== named) {
    return `answered ${range} under Content-Range ${contentRange ?? 'none'}, not ${named}`;
  }
  // The range's own length, which a player or a resumed download frames the part by.
  const length = answer.headers['content-length'];
  if (length !== String(end)) {
    return `answered ${range} with Content-Length ${length ?? 'none'}, not the range's ${end}`;
  }
  const { head } = subject;
  if (head === undefined) {
    return `answered ${range} of a file the build holds no bytes of`;
  }
  if (answer.length !== end || !answer.head.subarray(0, end).equals(head.subarray(1, end + 1))) {
    return `answered ${range} with other bytes than the file's`;
  }
  // Whatever its bytes, the part of the file a player or a resumed download is given is the file:
  // its type, its tag, how it is held, every header the application set and its cookies.
  const described = describedFailure(answer, expected, false);
  return described === undefined ? undefined : `asked for ${range}, ${described}`;
}

/**
 * Why a range of a file the edge answers as itself is not the bytes it names, as the edge answers
 * the file it serves for the request (`partFailure`): a file of an error's status, which answers no
 * range, whole — and one of fewer than two bytes is asked for its second byte all the same, a
 * range no byte of it satisfies, which is answered `416`.
 */
export async function rangeFailure(
  stack: CheckedStack,
  url: URL,
  asked: {
    readonly file: StaticFileEntry;
    readonly headers: Readonly<Record<string, string>>;
    /** The whole file, as answered: its first bytes, by their digest the file's own. */
    readonly answer: Reading;
    /** The validator it is asked on (`If-Range`), where it is: one the edge resumes on. */
    readonly ifRange?: string | undefined;
  },
): Promise<string | undefined> {
  const { file, ifRange } = asked;
  const end = Math.max(1, Math.min(file.byteLength - 1, RANGE_BYTES));
  const range = `bytes=1-${end}`;
  const sent = { ...asked.headers, range, ...(ifRange !== undefined && { 'if-range': ifRange }) };
  const what = ifRange === undefined ? range : `${range} on If-Range ${ifRange}`;
  const again = await askedAgain(stack, url, { sent, what });
  if (again.kind !== 'answered') {
    return again.kind === 'failed' ? again.reason : undefined;
  }
  const subject = subjectOf(stack, again, { file, head: asked.answer.head });
  return said(subject, partFailure(stack, url, { subject, again, sent, end, what }));
}

/** An If-Range tag must strongly name the representation selected by this follow-up. */
function resumesOn(headers: Readonly<Record<string, string>>, etag: string): boolean {
  const validator = headers['if-range'];
  return (
    validator === undefined ||
    (!validator.startsWith('W/') && !etag.startsWith('W/') && validator === etag)
  );
}

/**
 * Why a range of a file asked for on the very tag it is served under (`If-Range`), as a resumed
 * download asks once its copy is the file's, is not answered as the range asked for plainly is
 * (`rangeFailure`): a strong tag compares equal to itself, and the edge resumes on it. A weak one
 * resumes nothing however it is spelled, which the probe on a stale validator holds it to
 * (`staleRangeFailure`).
 */
export async function resumedRangeFailure(
  stack: CheckedStack,
  url: URL,
  asked: {
    readonly file: StaticFileEntry;
    readonly headers: Readonly<Record<string, string>>;
    readonly answer: Reading;
    readonly etag: string;
  },
): Promise<string | undefined> {
  const { etag, ...plain } = asked;
  return etag.startsWith('W/') ? undefined : rangeFailure(stack, url, { ...plain, ifRange: etag });
}

/**
 * Why a range of a file asked for on a validator no range is resumed on (`If-Range`), as a resumed
 * download asks once its copy may be stale, is not answered with the whole file, as the edge
 * answers one (`requestedRange`): the weak form of the file's own tag, which RFC 9110 compares
 * strongly, and a weak tag never matches. A part of the file in its place would splice bytes of
 * two versions into the client's copy.
 */
export async function staleRangeFailure(
  stack: CheckedStack,
  url: URL,
  asked: {
    readonly file: StaticFileEntry;
    readonly headers: Readonly<Record<string, string>>;
    readonly head: Buffer;
    readonly etag: string;
  },
): Promise<string | undefined> {
  const end = Math.max(1, Math.min(asked.file.byteLength - 1, RANGE_BYTES));
  const range = `bytes=1-${end}`;
  const condition = `W/${opaqueTag(asked.etag)}`;
  const what = `${range} on If-Range ${condition}`;
  const sent = { ...asked.headers, range, 'if-range': condition };
  const again = await askedAgain(stack, url, { sent, what });
  if (again.kind !== 'answered') {
    return again.kind === 'failed' ? again.reason : undefined;
  }
  const subject = subjectOf(stack, again, asked);
  const expected = expectationOf(stack, url, subject.file, { ...again, headers: sent });
  const whole = fileFailure(subject.file, again.answer, expected);
  return said(subject, whole === undefined ? undefined : `asked for ${what}, ${whole}`);
}

/**
 * Why a range of a file the edge answers as itself, asked for by its end (`bytes=-<n>`, as a media
 * player asks for an index kept there) or from a byte on (`bytes=1-`, as a resumed download asks), is
 * not answered as the edge answers one (`requestedRange`): `206` under the `Content-Range` those
 * bytes are, their length, those bytes of the file, and the whole file's headers — and an empty
 * file, which has no last byte, `416`. A file of an error's status answers no range: its bounded
 * range holds it to that already (`rangeFailure`).
 */
export async function rangeFormsFailure(
  stack: CheckedStack,
  url: URL,
  asked: {
    readonly file: StaticFileEntry;
    readonly headers: Readonly<Record<string, string>>;
    /** The whole file, as answered: its first and last bytes, by their digest the file's own. */
    readonly answer: Reading;
  },
): Promise<string | undefined> {
  if ((asked.file.status ?? HTTP_OK) !== HTTP_OK) {
    return undefined;
  }
  const suffix = Math.max(1, Math.min(asked.file.byteLength, RANGE_BYTES));
  // From a byte on, only where the file has one past its first: a tiny file's range is asked by
  // its bounded form already (`rangeFailure`), which no byte of it satisfies.
  const forms =
    asked.file.byteLength < 2
      ? [{ range: `bytes=-${suffix}`, startOf: (length: number) => Math.max(0, length - suffix) }]
      : [
          { range: `bytes=-${suffix}`, startOf: (length: number) => Math.max(0, length - suffix) },
          { range: 'bytes=1-', startOf: () => 1 },
        ];
  for (const { range, startOf } of forms) {
    const sent = { ...asked.headers, range };
    const again = await askedAgain(stack, url, { sent, what: range });
    if (again.kind === 'failed') {
      return again.reason;
    }
    if (again.kind !== 'answered') {
      continue;
    }
    const subject = subjectOf(stack, again, { file: asked.file, head: asked.answer.head });
    const failure = await formFailure(stack, url, {
      range,
      startOf,
      subject,
      again,
      sent,
      whole: asked.answer,
    });
    if (failure !== undefined) {
      return said(subject, failure);
    }
  }
  return undefined;
}

/** Why a range by its end or from a byte on is not those bytes of the file it serves (`rangeFormsFailure`). */
async function formFailure(
  stack: CheckedStack,
  url: URL,
  read: {
    readonly range: string;
    readonly startOf: (length: number) => number;
    readonly subject: Subject;
    readonly again: Extract<AskedAgain, { kind: 'answered' }>;
    readonly sent: Readonly<Record<string, string>>;
    /** The whole file asked for, as answered. */
    readonly whole: Reading;
  },
): Promise<string | undefined> {
  const { range, subject, again, sent } = read;
  const { file } = subject;
  const { answer } = again;
  const expected = expectationOf(stack, url, file, { ...again, headers: sent });
  if ((file.status ?? HTTP_OK) !== HTTP_OK) {
    const whole = fileFailure(file, answer, expected);
    return whole === undefined ? undefined : `asked for ${range}, ${whole}`;
  }
  const length = file.byteLength;
  if (length === 0) {
    return unsatisfiedFailure(range, { file, answer, expected });
  }
  if (answer.status !== PARTIAL_CONTENT_STATUS) {
    return `answered ${range} with ${answer.status}, not ${PARTIAL_CONTENT_STATUS}`;
  }
  const start = read.startOf(length);
  const named = `bytes ${start}-${length - 1}/${length}`;
  const contentRange = answer.headers['content-range'];
  if (contentRange !== named) {
    return `answered ${range} under Content-Range ${contentRange ?? 'none'}, not ${named}`;
  }
  const size = length - start;
  if (answer.headers['content-length'] !== String(size) || answer.length !== size) {
    return `answered ${range} with ${answer.length} bytes, not the range's ${size}`;
  }
  // The file asked for, by what its whole answer kept of it; another it was rewritten onto, by its
  // blob of the build.
  const bytes =
    subject.onto === undefined
      ? keptBytesAt(read.whole, start, length)
      : blobBytesAt(stack, file, start, RANGE_BYTES);
  if (bytes === undefined) {
    return `answered ${range} of a file the build holds no bytes of`;
  }
  if (!answer.head.subarray(0, bytes.length).equals(bytes)) {
    return `answered ${range} with other bytes than the file's`;
  }
  if (size > bytes.length) {
    const expectedDigest = await rangeDigestOf(stack, file, start);
    if (expectedDigest === undefined) {
      return `answered ${range} of a file the build holds no bytes of`;
    }
    if (answer.sha256 !== expectedDigest) {
      return `answered ${range} with other bytes than the file's`;
    }
  }
  const described = describedFailure(answer, expected, false);
  return described === undefined ? undefined : `asked for ${range}, ${described}`;
}

/**
 * A range's worth of a file's bytes from `start` on (`length` in all), as its whole answer kept them:
 * its first bytes (`head`), or its last (`tail`); none where neither holds them.
 */
function keptBytesAt(whole: Reading, start: number, length: number): Buffer | undefined {
  const wanted = Math.min(length - start, RANGE_BYTES);
  if (start + wanted <= whole.head.length) {
    return whole.head.subarray(start, start + wanted);
  }
  const fromEnd = length - start;
  if (fromEnd > whole.tail.length) {
    return undefined;
  }
  const at = whole.tail.length - fromEnd;
  return whole.tail.subarray(at, at + wanted);
}
