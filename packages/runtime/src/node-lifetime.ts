export interface NodeTaskSnapshot {
  readonly activeRequests: number;
  readonly backgroundTasks: number;
  readonly draining: boolean;
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
    // eslint-disable-next-line unicorn/prefer-await -- Register lifetime without blocking a streaming response.
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
    if (this.#idle()) return true;
    return await new Promise<boolean>((resolve) => {
      const done = (drained: boolean): void => {
        clearTimeout(timer);
        this.#changed.delete(changed);
        resolve(drained);
      };
      const changed = (): void => {
        if (this.#idle()) done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.#changed.add(changed);
      changed();
    });
  }
}
