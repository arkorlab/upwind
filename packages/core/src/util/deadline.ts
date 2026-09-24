/** Wall-clock deadlines for work that a remote origin controls the pace of. */

class DeadlineError extends Error {
  constructor(what: string, options?: ErrorOptions) {
    super(`${what} timed out`, options);
    this.name = 'DeadlineError';
  }
}

/** Whether a failure is the deadline running out, rather than the work itself failing. */
export function isDeadlineError(error: unknown): boolean {
  return error instanceof DeadlineError;
}

/**
 * Reject with `DeadlineError` when `promise` outlives `ms`.
 *
 * A non-positive budget rejects immediately: the deadline has already passed, so starting the work
 * would extend it. The timer is always cleared, so a resolved race leaves nothing pending.
 */
export async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  if (ms <= 0) {
    throw new DeadlineError(what);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineError(what));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    // Not `clearTimeout(timer)`: the handle type differs between the runtimes this runs on, and
    // only one of them accepts `undefined`.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
