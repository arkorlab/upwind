import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import { isReserved, type StaticFileEntry } from '@stayingupwind/core/manifest';

import {
  answeredBy,
  answerTo,
  type CheckedStack,
  EDGE_HEADER,
  FROM_STORAGE,
  middlewareAnswered,
  policyFailure,
  traced,
  edgeReads,
} from './answers.ts';
import {
  decisionOf,
  ignoredRewrite,
  ontoAnotherFile,
  rewrittenOntoNoFile,
  selectionChanged,
} from './file-decisions.ts';
import type { Decided } from './file-expectations.ts';
import type { Reading } from './reading.ts';

/**
 * A file the edge answered from storage, asked for again (`follow-ups.ts`, `ranges.ts`): a request
 * of its own to the application's routing (`askedAgain`), answered as the file it asked for or as
 * the other file of the build the middleware rewrote that request onto (`subjectOf`), whose bytes
 * the build's blob holds (`blobBytesAt`).
 */

/** As many bytes of a file as its range is asked for, past its first: a resumed download's. */
export const RANGE_BYTES = 64;

/**
 * What a file asked for again comes to: its answer, what the middleware decided for it — which runs
 * on every request, and may set another cookie on each — and the other file of the build it
 * rewrote that request onto, where it did (`ontoAnotherFile`); a failure to answer, or the
 * application's.
 */
export type AskedAgain =
  | {
      readonly kind: 'answered';
      readonly answer: Reading;
      readonly middleware: Decided;
      readonly onto: { readonly pathname: string; readonly file: StaticFileEntry } | undefined;
    }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'theirs' };

/**
 * A file asked for again with `sent` — a range of it, on a condition, for its headers alone — as a
 * request of its own to the application's routing: a rule that claims it for what it adds, and a
 * middleware that answers it, rewrites it onto no file — which the Function answers — or changes
 * what it selects, are the application's, and it is judged no further. Otherwise it has to be
 * served from storage, as the whole file was — the file, or the other file of the build the
 * middleware rewrote this request onto, which the edge serves in its place: a Function's answer in
 * its place is the edge failing to serve it, and one from storage to a rewrite onto no file the
 * edge ignoring the rewrite.
 */
export async function askedAgain(
  stack: CheckedStack,
  url: URL,
  asked: {
    readonly sent: Readonly<Record<string, string>>;
    readonly what: string;
    readonly method?: 'HEAD' | undefined;
  },
): Promise<AskedAgain> {
  const { sent, what } = asked;
  if (isReserved(stack.manifest, url, edgeReads(sent), true)) {
    return { kind: 'theirs' };
  }
  await using tracing = await traced(stack, sent);
  const { headers, trace } = tracing;
  const answer = await answerTo(url, {
    via: stack.url,
    method: asked.method,
    headers,
    headBytes: RANGE_BYTES,
  });
  if (typeof answer === 'string') {
    return { kind: 'failed', reason: `asked for ${what}, ${answer}` };
  }
  if (middlewareAnswered(answer) !== undefined) {
    return { kind: 'theirs' };
  }
  const decision = await decisionOf(stack, answer, { trace, url, sent });
  if ('failure' in decision) {
    return { kind: 'failed', reason: `asked for ${what}, ${decision.failure}` };
  }
  const middleware = decision.decided;
  const answered = answeredBy(answer);
  const fromStorage = answered.startsWith(FROM_STORAGE);
  // Rewritten onto no file of the build, it is the Function's to answer, as the edge hands it on —
  // which is the application's, whatever the whole file was (`middlewareAnswered`): served from
  // storage all the same, it is the rewrite ignored, as for the whole file (`servedVerdict`).
  const nowhere = rewrittenOntoNoFile(stack, middleware);
  if (nowhere !== undefined && fromStorage) {
    return { kind: 'failed', reason: `asked for ${what}, ${ignoredRewrite(nowhere)}` };
  }
  if (selectionChanged(sent, middleware)) {
    return { kind: 'theirs' };
  }
  if (!fromStorage) {
    return {
      kind: 'failed',
      reason: `answered ${what} not from storage (${EDGE_HEADER}: ${answered})`,
    };
  }
  // Under the policy the whole file was served by, as every answer from storage is.
  const policy = policyFailure(stack, answer);
  return policy === undefined
    ? { kind: 'answered', answer, middleware, onto: ontoAnotherFile(stack, url, middleware) }
    : { kind: 'failed', reason: `asked for ${what}, ${policy}` };
}

/**
 * The file a request asked for again is answered as, and its first bytes: the file asked for — its
 * bytes as the whole answer was read — or the other file of the build the middleware rewrote that
 * request onto, its bytes read from the build's blob of it, which the edge serves in its place.
 */
export interface Subject {
  readonly file: StaticFileEntry;
  /** Its first bytes, a range's worth past its first; none where the build holds no blob of it. */
  readonly head: Buffer | undefined;
  /** Where the request was rewritten onto another file, that file's pathname, which a verdict names. */
  readonly onto: string | undefined;
}

/** The first bytes of a file of the build, as its blob holds them; none where it holds none. */
function blobHeadOf(stack: CheckedStack, file: StaticFileEntry): Buffer | undefined {
  return blobBytesAt(stack, file, 0, RANGE_BYTES + 1);
}

/**
 * As many as `count` bytes of a file of the build from `offset` on, as its blob holds them; none
 * where it holds none.
 */
export function blobBytesAt(
  stack: CheckedStack,
  file: StaticFileEntry,
  offset: number,
  count: number,
): Buffer | undefined {
  const wanted = Math.max(0, Math.min(file.byteLength - offset, count));
  let descriptor: number;
  try {
    descriptor = openSync(path.join(stack.bundleDir, 'blobs', file.sha256), 'r');
  } catch {
    return undefined;
  }
  try {
    const bytes = Buffer.alloc(wanted);
    const read = readSync(descriptor, bytes, 0, wanted, offset);
    return bytes.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

/** An entity tag without its weakness, as two are compared weakly. */
export function opaqueTag(tag: string): string {
  return tag.replace(/^W\//u, '');
}

/** What a request asked for again was answered as (`Subject`). */
export function subjectOf(
  stack: CheckedStack,
  again: Extract<AskedAgain, { kind: 'answered' }>,
  asked: { readonly file: StaticFileEntry; readonly head: Buffer },
): Subject {
  const { onto } = again;
  return onto === undefined
    ? { file: asked.file, head: asked.head, onto: undefined }
    : { file: onto.file, head: blobHeadOf(stack, onto.file), onto: onto.pathname };
}

/** A verdict on a subject, naming the file the request was rewritten onto where it was. */
export function said(subject: Subject, failure: string | undefined): string | undefined {
  return failure === undefined || subject.onto === undefined
    ? failure
    : `rewritten onto ${subject.onto}, ${failure}`;
}
