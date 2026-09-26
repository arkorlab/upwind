import { SHARED_ANSWER_HEADER } from '@stayingupwind/core/paas';
import { withoutPlatformHeaders } from '@stayingupwind/core/request';

/**
 * Which answers a host may share, said so that no application can say it.
 *
 * The host reads one header to learn that an answer is a stored generation's — the same bytes for
 * every visitor, under a validator — and may then leave it shareable. An application writes
 * response headers of its own on every path that answers a request: a render, a middleware, a
 * `next.config` header rule, a rewrite to another origin. Taking the platform's prefix off each of
 * those in turn is a list, and a list is something to be incomplete.
 *
 * So the runtime marks its own answer with a value only this isolate knows, and the one place every
 * answer passes through takes the whole prefix off and puts the header back — as the plain `1` the
 * host reads — for the answer whose mark matched. An application may write the header; it cannot
 * write the value, so what reaches the host under that prefix is only ever the runtime's.
 *
 * The mark is made at the first answer rather than as this module is evaluated: a Function's global
 * scope is not where to ask for randomness.
 */

const made: { mark: string | undefined } = { mark: undefined };

function sharedMark(): string {
  made.mark ??= crypto.randomUUID();
  return made.mark;
}

/** Say that this answer is a generation's, and may be shared. */
export function markSharedAnswer(headers: Headers): void {
  headers.set(SHARED_ANSWER_HEADER, sharedMark());
}

/**
 * The answer as it leaves the runtime: nothing of the application's under the platform's prefix,
 * and the shared-answer header only where this runtime put its own mark there.
 */
export function settleSharedAnswer(answered: Response): Response {
  const shared = answered.headers.get(SHARED_ANSWER_HEADER) === sharedMark();
  const settled = withoutPlatformHeaders(answered);
  if (shared) {
    // Either the same response, whose headers were ours to edit, or a copy that is.
    settled.headers.set(SHARED_ANSWER_HEADER, '1');
  }
  return settled;
}
