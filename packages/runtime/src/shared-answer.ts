import { CACHE_OUTCOME_HEADER, SHARED_ANSWER_HEADER } from '@stayingupwind/core/paas';
import { withoutPlatformHeaders } from '@stayingupwind/core/request';

import { requestContext } from './cache/context.ts';

const HTTP_LOWEST_STATUS = 200;
const HTTP_HIGHEST_STATUS = 599;

/**
 * What the runtime tells its host about an answer, said so that no application can say it.
 *
 * A host reads a header or two to learn what only the runtime knows: that an answer is a stored
 * generation's — the same bytes for every visitor, under a validator, so it may be shared — and
 * what a regeneration this request asked for came to. An application writes response headers on
 * every path that answers a request: a render, a middleware, a `next.config` header rule, a rewrite
 * to another origin. Taking the platform's prefix off each of those in turn is a list, and a list is
 * something to be incomplete.
 *
 * So none of it travels on the response while it is being made. The runtime records what it has to
 * say in the request's own context, where the application cannot reach; the one place every answer
 * passes through takes the whole prefix off whatever came back and writes those and nothing else.
 * An application may write any header it likes and none of it will be read as the runtime's.
 */

function say(name: string, value: string): void {
  requestContext()?.hostHeaders.set(name, value);
}

/** Say that this answer is a generation's, and may be shared. */
export function saySharedAnswer(): void {
  say(SHARED_ANSWER_HEADER, '1');
}

/** Say what the regeneration this request asked for came to; the host counts these. */
export function sayCacheOutcome(outcome: string): void {
  say(CACHE_OUTCOME_HEADER, outcome);
}

/**
 * Run `work` as an answer of its own: what it says to the host is not said of the answer this
 * request is making.
 *
 * The image optimizer asks for its own source through a whole inner request, and a source that is a
 * route handler's cached body says it may be shared — of itself, not of the image built out of it.
 * Said into the one place, it would have been said of the image too.
 */
export async function asAnotherAnswer<T>(work: () => Promise<T>): Promise<T> {
  const said = requestContext()?.hostHeaders;
  const before = said === undefined ? undefined : new Map(said);
  try {
    return await work();
  } finally {
    if (said !== undefined && before !== undefined) {
      said.clear();
      for (const [name, value] of before) {
        said.set(name, value);
      }
    }
  }
}

/** The answer as it leaves the runtime: the host's headers are the runtime's own, and only those. */
export function settleHostHeaders(answered: Response): Response {
  const settled = withoutPlatformHeaders(answered);
  const said = requestContext()?.hostHeaders;
  if (said === undefined || said.size === 0) {
    return settled;
  }
  try {
    for (const [name, value] of said) {
      settled.headers.set(name, value);
    }
    return settled;
  } catch {
    // Headers that came back from a call are not ours to edit; said on a copy instead. A status no
    // `Response` can be built around is a protocol switch or an error, and a host reads neither of
    // these of it.
    return rebuildable(settled.status) ? saidOn(settled, said) : settled;
  }
}

function rebuildable(status: number): boolean {
  return status >= HTTP_LOWEST_STATUS && status <= HTTP_HIGHEST_STATUS;
}

function saidOn(answered: Response, said: ReadonlyMap<string, string>): Response {
  const headers = new Headers(answered.headers);
  for (const [name, value] of said) {
    headers.set(name, value);
  }
  return new Response(answered.body, {
    status: answered.status,
    statusText: answered.statusText,
    headers,
  });
}
