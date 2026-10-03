import { requestEntry } from './request-context.ts';

/**
 * Where Sentry's Next.js SDK reads its random values and its clock, on a runtime whose async
 * context belongs to one request.
 *
 * With `cacheComponents`, Next.js aborts a prerender that reads `crypto.randomUUID()`,
 * `Math.random()` or the clock while it renders — a value that changes from one render to the
 * next would be baked into the shell — and the SDK reads all three for the scopes and spans it
 * makes as Next.js renders. So `@sentry/nextjs` takes a snapshot of the async context as it is set
 * up, outside every store Next.js enters, and runs each read in it. It hands that runner to
 * `@sentry/core` under a global symbol, and each copy of `@sentry/core` resolves the symbol once,
 * at the first read it makes.
 *
 * workerd lets a snapshot be entered only within the request that took it, and throws "Cannot call
 * this AsyncLocalStorage bound function outside of the request in which it was created" in any
 * other. The SDK answers that by taking a new snapshot of the context the read is made in, and
 * keeping it for every later read in the isolate. Two requests served at once then take turns
 * replacing it, and once one replaces it during a prerender — Next.js's spans make IDs all through
 * one — the read happens inside the prerender after all: Next.js aborts it, and the request is
 * answered 500 with an error that carries no message.
 *
 * The symbol answers here with a runner that keeps one context per request instead: the one the
 * request entered the Function in (`requestEntry`), which is within the request and outside
 * anything the application entered since. What the SDK sets is kept, and runs the reads made
 * where there is no request to run them in.
 */

const RUNNER = Symbol.for('__SENTRY_SAFE_RANDOM_ID_WRAPPER__');

type Runner = <T>(read: () => T) => T;

const shared: { sdk: Runner | undefined; installed: boolean } = {
  sdk: undefined,
  installed: false,
};

function isRunner(value: unknown): value is Runner {
  return typeof value === 'function';
}

function runInRequestEntry<T>(read: () => T): T {
  const entry = requestEntry();
  if (entry !== undefined) {
    const attempt = { began: false };
    try {
      return entry(() => {
        attempt.began = true;
        return read();
      });
    } catch (error) {
      // What the read threw is the caller's to see. Only a context that would not be entered —
      // the code running here for some request other than the one the context belongs to — falls
      // through to the runner the SDK set, as it would have run without this one.
      if (attempt.began) {
        throw error;
      }
    }
  }
  return shared.sdk === undefined ? read() : shared.sdk(read);
}

/** Installed once per isolate, before any of the application is evaluated. */
export function installRandomSafeContext(): void {
  if (shared.installed) {
    return;
  }
  shared.installed = true;
  const existing: unknown = Reflect.get(globalThis, RUNNER);
  if (isRunner(existing)) {
    shared.sdk = existing;
  }
  Object.defineProperty(globalThis, RUNNER, {
    configurable: true,
    // A function from the start, whether or not the SDK has set one up yet: a copy of
    // `@sentry/core` that found none at its first read would read where it stands from then on.
    get: (): Runner => runInRequestEntry,
    set: (runner: unknown): void => {
      if (isRunner(runner)) {
        shared.sdk = runner;
      }
    },
  });
}
