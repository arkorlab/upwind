/** Node's largest finite timer delay, before setTimeout would clamp it to one millisecond. */
const MAX_TIMEOUT_MS = 2_147_483_647;

type Report = (error: unknown) => unknown;

async function allSettled(pending: Iterable<Promise<void>>): Promise<true> {
  await Promise.all(pending);
  return true;
}

async function reportSafely(report: Report, error: unknown): Promise<void> {
  try {
    await report(error);
  } catch {
    // Reporting must not change the task's lifetime.
  }
}

/**
 * Node promises do not keep the event loop alive. A host owns the shutdown deadline and retains
 * the server/resources while this group drains. This is not a durable queue: a process crash can
 * still lose accepted work.
 */
export class TaskGroup {
  readonly #pending = new Set<Promise<void>>();
  readonly #report: Report;

  readonly waitUntil = (promise: Promise<unknown>): void => {
    const tracked = this.#observe(promise);
    this.#pending.add(tracked);
    // This observer must not delay admission or response delivery. observe contains every failure;
    // this final guard also prevents an unexpected bookkeeping failure becoming unhandled.
    // eslint-disable-next-line unicorn/prefer-await -- waitUntil registers work without waiting for it.
    this.#forget(tracked).catch(() => {
      // The task's failure was reported by observe.
    });
  };

  constructor(report: Report) {
    this.#report = report;
  }

  async #observe(promise: Promise<unknown>): Promise<void> {
    try {
      await promise;
    } catch (error) {
      // Reporting is deliberately detached: an error reporter must not hold accepted work open.
      // eslint-disable-next-line unicorn/prefer-await -- Drain tracks the task, not its reporter.
      reportSafely(this.#report, error).catch(() => {
        // The reporter's own failure is already contained.
      });
    }
  }

  async #forget(tracked: Promise<void>): Promise<void> {
    await tracked;
    this.#pending.delete(tracked);
  }

  get size(): number {
    return this.#pending.size;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError('task drain timeout must be a nonnegative finite number');
    }
    if (this.#pending.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    try {
      // A task may register another task while settling. Take snapshots until empty, but do not
      // leave a draining loop behind after its caller has already reached the deadline.
      while (this.#pending.size > 0) {
        if (!(await Promise.race([allSettled(this.#pending), expired]))) return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }
}
