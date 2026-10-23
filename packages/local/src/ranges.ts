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
import { type ByteRange, requestedRange } from './byte-ranges.ts';
import {
  describedFailure,
  expectationOf,
  type FileExpectation,
  fileFailure,
} from './file-expectations.ts';
import { rangeDigestOf, spanDigestOf } from './range-digests.ts';
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
export function unsatisfiedFailure(
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
 * What a request asked again selects of the file it is answered as — the one the middleware rewrote
 * it onto, where it did — read as the edge reads it (`requestedRange`): the part it names; `null`
 * for one no byte of that file satisfies, answered `416`; none for one the edge answers whole, on a
 * validator other than the file's own tag (`If-Range`), or of a file of an error's status, which
 * answers no range. The file's own length decides where the range falls (Codex): a range a longer
 * file asked for holds may start past the end of a shorter one it was rewritten onto.
 */
function selectionOf(
  file: StaticFileEntry,
  sent: Readonly<Record<string, string>>,
  tag: string,
): ByteRange | null | undefined {
  return (file.status ?? HTTP_OK) === HTTP_OK
    ? requestedRange(new Headers(sent), tag, file.byteLength)
    : undefined;
}

/**
 * Why a range of a file the edge answers as itself (`bytes=1-<end>`), as a resumed download or a
 * media player asks for one, is not answered as the edge answers it of the file it serves
 * (`selectionOf`): its bytes, served as a range (`206`, `Content-Range`, the range's own
 * `Content-Length`) with the whole file's headers; a file no byte past its first satisfies the range
 * of, `416`; and one of an error's status, or asked on a validator it is not served under, whole.
 */
function partFailure(
  stack: CheckedStack,
  url: URL,
  read: {
    readonly subject: Subject;
    readonly again: Extract<AskedAgain, { kind: 'answered' }>;
    readonly sent: Readonly<Record<string, string>>;
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
  const selected = selectionOf(file, sent, expected.etag);
  if (selected === undefined) {
    const whole = fileFailure(file, answer, expected);
    return whole === undefined ? undefined : `asked for ${range}, ${whole}`;
  }
  if (selected === null) {
    return unsatisfiedFailure(range, { file, answer, expected });
  }
  if (answer.status !== PARTIAL_CONTENT_STATUS) {
    return `answered ${range} with ${answer.status}, not ${PARTIAL_CONTENT_STATUS}`;
  }
  const { start, end } = selected;
  const named = `bytes ${start}-${end}/${file.byteLength}`;
  const contentRange = answer.headers['content-range'];
  if (contentRange !== named) {
    return `answered ${range} under Content-Range ${contentRange ?? 'none'}, not ${named}`;
  }
  // The range's own length, which a player or a resumed download frames the part by.
  const size = end - start + 1;
  const length = answer.headers['content-length'];
  if (length !== String(size)) {
    return `answered ${range} with Content-Length ${length ?? 'none'}, not the range's ${size}`;
  }
  const { head } = subject;
  if (head === undefined) {
    return `answered ${range} of a file the build holds no bytes of`;
  }
  if (
    answer.length !== size ||
    !answer.head.subarray(0, size).equals(head.subarray(start, start + size))
  ) {
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
  return said(subject, partFailure(stack, url, { subject, again, sent, what }));
}

/**
 * Why a file asked for by a request that carries a range of it (`what`) — one a rule of `next.config`
 * conditioned on a range has it carry (Codex) — is not answered as the edge answers the range it names
 * (`requestedRange`): `206` under the `Content-Range` those bytes are, their length, every one of those
 * bytes of the file, and the whole file's headers — the rule's among them.
 */
export async function selectedRangeFailure(
  stack: CheckedStack,
  subject: Subject,
  read: {
    readonly answer: Reading;
    readonly what: string;
    readonly range: ByteRange;
    readonly expected: FileExpectation;
    /** The whole file asked for, as answered: what it kept of the file's bytes. */
    readonly whole: Reading;
  },
): Promise<string | undefined> {
  const { file } = subject;
  const { answer, what, range, expected } = read;
  if (answer.status !== PARTIAL_CONTENT_STATUS) {
    return `answered ${what} with ${answer.status}, not ${PARTIAL_CONTENT_STATUS}`;
  }
  const named = `bytes ${range.start}-${range.end}/${file.byteLength}`;
  const contentRange = answer.headers['content-range'];
  if (contentRange !== named) {
    return `answered ${what} under Content-Range ${contentRange ?? 'none'}, not ${named}`;
  }
  const size = range.end - range.start + 1;
  if (answer.headers['content-length'] !== String(size) || answer.length !== size) {
    return `answered ${what} with ${answer.length} bytes, not the range's ${size}`;
  }
  // As many of its bytes as were read, against the file's own from where the range starts: its first
  // bytes as the whole file was answered, by their digest the file's own, where they reach that far;
  // its blob otherwise.
  const seen = answer.head.subarray(0, Math.min(size, answer.head.length));
  const { head } = subject;
  const held =
    head !== undefined && head.length >= range.start + seen.length
      ? head.subarray(range.start, range.start + seen.length)
      : blobBytesAt(stack, file, range.start, seen.length);
  if (held === undefined) {
    return `answered ${what} of a file the build holds no bytes of`;
  }
  if (!seen.equals(held)) {
    return `answered ${what} with other bytes than the file's`;
  }
  // And past them, by their digest (greptile, Codex): a part a rule selects runs as long as its range
  // does, and a byte past those read first is as much the file's as they — held to those bytes of the
  // file by what its whole answer kept of them where it kept them all, by its blob otherwise
  // (`spanDigestOf`), as a range by its end or from a byte on is (`formBytesFailure`).
  if (size > seen.length) {
    const expectedDigest = await spanDigestOf(
      stack,
      file,
      { start: range.start, stop: range.end + 1 },
      subject.onto === undefined ? read.whole : undefined,
    );
    if (expectedDigest === undefined) {
      return `answered ${what} of a file the build holds no bytes of`;
    }
    if (answer.sha256 !== expectedDigest) {
      return `answered ${what} with other bytes than the file's`;
    }
  }
  const described = describedFailure(answer, expected, false);
  return described === undefined ? undefined : `asked for ${what}, ${described}`;
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
 * bytes are, their length, those bytes of the file, and the whole file's headers — and a file no
 * byte of which is where the range starts, `416`: an empty one, or one the middleware rewrote the
 * request onto that is shorter than the file asked for (`formFailure`). A file of an error's status
 * answers no range: its bounded range holds it to that already (`rangeFailure`).
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
  const forms = asked.file.byteLength < 2 ? [`bytes=-${suffix}`] : [`bytes=-${suffix}`, 'bytes=1-'];
  for (const range of forms) {
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

/**
 * Why a range by its end or from a byte on is not those bytes of the file it serves
 * (`rangeFormsFailure`), as the edge selects them of that file (`selectionOf`, Codex): `416` where no
 * byte of it is where the range starts — an empty file, or one byte long asked from its second.
 */
async function formFailure(
  stack: CheckedStack,
  url: URL,
  read: {
    readonly range: string;
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
  const selected = selectionOf(file, sent, expected.etag);
  if (selected === undefined) {
    const whole = fileFailure(file, answer, expected);
    return whole === undefined ? undefined : `asked for ${range}, ${whole}`;
  }
  if (selected === null) {
    return unsatisfiedFailure(range, { file, answer, expected });
  }
  if (answer.status !== PARTIAL_CONTENT_STATUS) {
    return `answered ${range} with ${answer.status}, not ${PARTIAL_CONTENT_STATUS}`;
  }
  // Each form runs to the file's last byte, which `formBytesFailure` proves them to.
  const { start, end } = selected;
  const named = `bytes ${start}-${end}/${file.byteLength}`;
  const contentRange = answer.headers['content-range'];
  if (contentRange !== named) {
    return `answered ${range} under Content-Range ${contentRange ?? 'none'}, not ${named}`;
  }
  const size = end - start + 1;
  if (answer.headers['content-length'] !== String(size) || answer.length !== size) {
    return `answered ${range} with ${answer.length} bytes, not the range's ${size}`;
  }
  const bytes = await formBytesFailure(stack, subject, { range, start, answer, whole: read.whole });
  if (bytes !== undefined) return bytes;
  const described = describedFailure(answer, expected, false);
  return described === undefined ? undefined : `asked for ${range}, ${described}`;
}

/** Prove every range byte, using retained bytes only when they cover the complete range. */
async function formBytesFailure(
  stack: CheckedStack,
  subject: Subject,
  read: {
    readonly range: string;
    readonly start: number;
    readonly answer: Reading;
    readonly whole: Reading;
  },
): Promise<string | undefined> {
  const { range, start, answer } = read;
  const { file } = subject;
  const length = file.byteLength;
  const size = length - start;
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
    const expectedDigest = await rangeDigestOf(
      stack,
      file,
      start,
      subject.onto === undefined ? read.whole : undefined,
    );
    if (expectedDigest === undefined) {
      return `answered ${range} of a file the build holds no bytes of`;
    }
    if (answer.sha256 !== expectedDigest) {
      return `answered ${range} with other bytes than the file's`;
    }
  }
  return undefined;
}

/**
 * A range's worth of a file's bytes from `start` on (`length` in all), as its whole answer kept them:
 * its first bytes (`head`), or its last (`tail`); none where neither holds them.
 */
function keptBytesAt(whole: Reading, start: number, length: number): Buffer | undefined {
  const wanted = Math.min(length - start, RANGE_BYTES);
  if (start < whole.head.length) {
    return whole.head.subarray(start, Math.min(start + wanted, whole.head.length));
  }
  const fromEnd = length - start;
  if (fromEnd > whole.tail.length) {
    return undefined;
  }
  const at = whole.tail.length - fromEnd;
  return whole.tail.subarray(at, at + wanted);
}
