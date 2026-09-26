/**
 * The Function's own `env`, where application code can reach it.
 *
 * A hosted application is Next.js, and Next.js server code sees `process.env` — which workerd
 * populates from text and secret bindings, and from those alone. A service binding is an object,
 * so it never appears there, and the dashboard's data access has no other way to find one. The
 * runtime publishes `env` here on its first request and the application reads bindings back out
 * by name.
 *
 * Per isolate, not per request, and that is sound for what is read through it: `env` is built
 * once for a Function's isolate and the bindings on it do not change underneath a deployment (the
 * cache runtime in `@stayingupwind/runtime` already rests on the same fact). A `Fetcher` is not a
 * request-scoped I/O object — unlike, say, a timer, which belongs to the request that made it —
 * so one taken on an earlier request still works on a later one.
 *
 * Nothing is published outside a Function: under `next dev`, `vitest` or a build, `bindingFetch`
 * answers `undefined` and every caller falls back to the URL it was configured with.
 */

/**
 * Deliberately global, and in the cross-realm registry rather than a module-level variable: the
 * runtime's bundle and the application's bundle are separate graphs in a deployment's Function, so
 * a value written by one would not be the one read by the other.
 */
const FUNCTION_ENV = Symbol.for('arkor.function-env');

interface FunctionEnvHolder {
  [FUNCTION_ENV]?: Record<string, unknown>;
}

function holder(): FunctionEnvHolder {
  return globalThis as unknown as FunctionEnvHolder;
}

/**
 * Publish the Function's environment. Called by the runtime at the top of `fetch`, on every
 * request rather than once: it costs an assignment, and an isolate that somehow saw two
 * environments would then read the current one rather than the first one it ever saw.
 */
export function publishFunctionEnv(env: unknown): void {
  if (typeof env === 'object' && env !== null) {
    // eslint-disable-next-line unicorn/no-unsafe-property-key -- a registry symbol, not a literal.
    holder()[FUNCTION_ENV] = env as Record<string, unknown>;
  }
}

/**
 * The environment a request was last handed, or nothing before the first request and outside a
 * Function: what the runtime reads a deployment's storage bindings from once it can.
 */
export function publishedFunctionEnv(): Readonly<Record<string, unknown>> | undefined {
  // eslint-disable-next-line unicorn/no-unsafe-property-key -- a registry symbol, not a literal.
  return holder()[FUNCTION_ENV];
}

/**
 * A `Fetcher`-shaped binding by name, as a plain `fetch` for the clients that take one, or
 * nothing when this is not a Function or holds no such binding.
 *
 * Only an object with a `fetch` answers. A text binding of the same name is not one: those the
 * application reads from `process.env`, and answering a URL here would let a caller mistake it
 * for a service.
 */
export function bindingFetch(name: string): typeof fetch | undefined {
  // eslint-disable-next-line unicorn/no-unsafe-property-key -- as above.
  const value = holder()[FUNCTION_ENV]?.[name];
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const service = value as { fetch?: typeof fetch };
  return typeof service.fetch === 'function' ? service.fetch.bind(service) : undefined;
}
