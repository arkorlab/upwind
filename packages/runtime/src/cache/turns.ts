import { type RequestContext, requestContext } from './context.ts';

/** A call let out in its turn. */
export type Turn = <T>(call: () => Promise<T>) => Promise<T>;

/**
 * How many calls a request has out to the host behind its work at once: a regeneration's uploads
 * and the data cache's writes, between them. A Function has six calls waiting for their headers at
 * the most, and the runtime holds any more back until one is done, without saying which. These come
 * in bursts — a page's every output once it is rendered, a value for each key a render fetched —
 * and the lease's heartbeat, the commit and the reads a render waits on would wait behind them:
 * slow enough, and the lease ran out under a render that had succeeded. Four leave two for those.
 */
export const CALLS_BEHIND_AT_ONCE = 4;

/** Each request's turns for the calls behind its work, gone with the request. */
const behindByRequest = new WeakMap<RequestContext, Turn>();

/**
 * The turns of the request under way for the calls behind its work, which all of them share
 * (`CALLS_BEHIND_AT_ONCE`). With no request in context — a suite that runs a piece of the runtime
 * alone — the calls take turns of their own.
 */
export function callsBehind(): Turn {
  const context = requestContext();
  if (context === undefined) {
    return inTurns(CALLS_BEHIND_AT_ONCE);
  }
  let turn = behindByRequest.get(context);
  if (turn === undefined) {
    turn = inTurns(CALLS_BEHIND_AT_ONCE);
    behindByRequest.set(context, turn);
  }
  return turn;
}

/**
 * A gate that lets `limit` calls out at once, and the rest out in the order they came: what a
 * piece of work that makes many calls of its own keeps to, where the runtime bounds how many a
 * Function may have open together and holds the rest back without saying which.
 */
export function inTurns(limit: number): Turn {
  let free = limit;
  const waiting: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (free > 0) {
      free -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      free += 1;
    } else {
      next();
    }
  };
  return async (call) => {
    await acquire();
    try {
      return await call();
    } finally {
      release();
    }
  };
}
