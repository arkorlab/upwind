import { type RequestContext, requestContext } from './context.ts';

/** A call let out in its turn. */
export type Turn = <T>(call: () => Promise<T>) => Promise<T>;

/**
 * How many calls a request has out to the host behind its work at once: a regeneration's uploads
 * and the fetch cache's writes, between them. A Function has six calls waiting for their headers at
 * the most, and the runtime holds any more back until one is done, without saying which. These come
 * in bursts — a page's every output once it is rendered, a value for each `fetch` a render made —
 * and the lease's heartbeat, the commit and the reads a render waits on would wait behind them:
 * slow enough, and the lease ran out under a render that had succeeded.
 */
export const CALLS_BEHIND_AT_ONCE = 4;

/**
 * How many writes and uploads a request has out at once, a `use cache` value's among them, so that
 * one of the six is the heartbeat's and the commit's whatever else is out. Next.js waits for a `use
 * cache` write before it has the render the value was made in: that write goes ahead of the calls
 * behind the work, past their four, and waits only where it would take the last of the six.
 */
export const WRITES_AT_ONCE = 5;

/**
 * A request's turns at the host: for the calls behind its work, and for a write its render waits
 * on.
 */
interface Lanes {
  readonly behind: Turn;
  readonly waitedOn: Turn;
}

/** Each request's lanes, gone with the request. */
const lanesByRequest = new WeakMap<RequestContext, Lanes>();

/**
 * The lanes of the request under way. With no request in context — a suite that runs a piece of
 * the runtime alone — each piece of work takes turns of its own, behind the work, and a write a
 * render waits on goes at once.
 */
function lanesOfRequest(): Lanes {
  const context = requestContext();
  if (context === undefined) {
    return { behind: inTurns(CALLS_BEHIND_AT_ONCE), waitedOn: async (call) => call() };
  }
  let lanes = lanesByRequest.get(context);
  if (lanes === undefined) {
    lanes = twoLanes(WRITES_AT_ONCE, CALLS_BEHIND_AT_ONCE);
    lanesByRequest.set(context, lanes);
  }
  return lanes;
}

/** The turns of the request under way for the calls behind its work (`CALLS_BEHIND_AT_ONCE`). */
export function callsBehind(): Turn {
  return lanesOfRequest().behind;
}

/** The turns of the request under way for a write its render waits on (`WRITES_AT_ONCE`). */
export function callsWaitedOn(): Turn {
  return lanesOfRequest().waitedOn;
}

/**
 * One gate with two lanes: no more than `all` calls out at once, no more than `behindAtMost` of
 * them from behind the work, and a call the render waits on let out ahead of any still waiting
 * there.
 */
function twoLanes(all: number, behindAtMost: number): Lanes {
  const lanes = { out: 0, behindOut: 0 };
  const waitingOn: (() => void)[] = [];
  const waitingBehind: (() => void)[] = [];
  const letOut = (): void => {
    while (lanes.out < all) {
      const waitedOn = waitingOn.shift();
      if (waitedOn !== undefined) {
        lanes.out += 1;
        waitedOn();
        continue;
      }
      const behind = lanes.behindOut < behindAtMost ? waitingBehind.shift() : undefined;
      if (behind === undefined) {
        return;
      }
      lanes.out += 1;
      lanes.behindOut += 1;
      behind();
    }
  };
  const lane = (isBehind: boolean): Turn => {
    return async (call) => {
      await new Promise<void>((resolve) => {
        (isBehind ? waitingBehind : waitingOn).push(resolve);
        letOut();
      });
      try {
        return await call();
      } finally {
        lanes.out -= 1;
        if (isBehind) {
          lanes.behindOut -= 1;
        }
        letOut();
      }
    };
  };
  return { behind: lane(true), waitedOn: lane(false) };
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
