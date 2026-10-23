import { isDeadlineError, withDeadline } from '@stayingupwind/core/util';

/**
 * How long the Function waits on a read of a gateway's (`readWithin`), and what it says of a read
 * that was slow to come: the deadlines themselves are the gateway's (`gateway.ts`).
 */

function warn(message: string, fields: Record<string, number>): void {
  // The Function's own log, as the runtime writes its own: nothing else sees what its cache did.
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ level: 'warn', msg: `cache-host: ${message}`, ...fields }));
}

/**
 * Tell of the read begun at `startedAt` in the Function's log, with how long it took, where that
 * was `slowMs` or more. The wall clock, not the request's: it moves with the read's I/O.
 */
function toldIfSlow(what: string, startedAt: number, slowMs: number | undefined): void {
  const tookMs = Date.now() - startedAt;
  if (slowMs !== undefined && tookMs >= slowMs) {
    warn(`${what} slow`, { tookMs });
  }
}

/**
 * `read`, given up once it has taken `deadlineMs`, and the request under it with it: it rejects
 * with the deadline's error, and the signal it was handed is aborted, so a gateway that has not
 * answered holds no connection of the render's. The race is what bounds the wait, whatever the
 * transport makes of the signal.
 *
 * Where `slowMs` is given, a read that comes to its end short of the deadline — answered, or failed
 * of its own — that long after it began or later is told of as slow (`toldIfSlow`): a read waited
 * for past the point it is reckoned slow at still shows as one, though it is answered. One given up
 * is not told of here: the runtime tells of it, as a read that failed.
 */
export async function readWithin<T>(
  what: string,
  deadlineMs: number,
  read: (signal: AbortSignal) => Promise<T>,
  slowMs?: number,
): Promise<T> {
  const controller = new AbortController();
  const startedAt = Date.now();
  try {
    const answer = await withDeadline(read(controller.signal), deadlineMs, what);
    toldIfSlow(what, startedAt, slowMs);
    return answer;
  } catch (error) {
    if (isDeadlineError(error)) {
      controller.abort(error);
    } else {
      toldIfSlow(what, startedAt, slowMs);
    }
    throw error;
  }
}
