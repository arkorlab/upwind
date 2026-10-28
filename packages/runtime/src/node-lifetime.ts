export interface NodeTaskSnapshot {
  readonly activeRequests: number;
  readonly backgroundTasks: number;
  readonly draining: boolean;
}
interface IdleWait {
  readonly promise: Promise<true>;
  readonly forget: () => void;
}

/** Node keeps promises alive; the controller needs to know when it may let the VM sleep. */
export class NodeLifetime {
  readonly #tasks = new Set<Promise<unknown>>();
  readonly #changed = new Set<() => void>();
  #active = 0;
  #draining = false;

  readonly waitUntil = (promise: Promise<unknown>): void => {
    this.#tasks.add(promise);
    const settled = (): void => {
      this.#settled(promise);
    };
    // eslint-disable-next-line promise/catch-or-return, unicorn/prefer-await, unicorn/prefer-then-catch -- Both outcomes settle lifetime exactly once without blocking the streaming response.
    promise.then(settled, settled);
  };

  #notify(): void {
    for (const changed of this.#changed) changed();
  }

  #settled(promise: Promise<unknown>): void {
    this.#tasks.delete(promise);
    this.#notify();
  }

  #idle(): boolean {
    return this.#active === 0 && this.#tasks.size === 0;
  }

  #untilIdle(): IdleWait {
    const idle = Promise.withResolvers<true>();
    const changed = (): void => {
      if (this.#idle()) idle.resolve(true);
    };
    this.#changed.add(changed);
    changed();
    return {
      promise: idle.promise,
      forget: () => {
        this.#changed.delete(changed);
      },
    };
  }

  snapshot(): NodeTaskSnapshot {
    return {
      activeRequests: this.#active,
      backgroundTasks: this.#tasks.size,
      draining: this.#draining,
    };
  }

  beginRequest(): () => void {
    this.#active += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#active -= 1;
      this.#notify();
    };
  }

  startDraining(): void {
    this.#draining = true;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    let waiting: IdleWait | undefined;
    try {
      for (;;) {
        waiting = this.#untilIdle();
        if (!(await Promise.race([waiting.promise, expired]))) return false;
        waiting.forget();
        waiting = undefined;
        // Later reactions to a retained promise may register more work after the idle notification.
        await Promise.resolve();
        if (this.#idle()) return true;
      }
    } finally {
      waiting?.forget();
      clearTimeout(timer);
    }
  }
}
