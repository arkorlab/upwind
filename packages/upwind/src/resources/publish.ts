import { type FunctionEnv, RESOURCES_SYMBOL_KEY, resourcesOf } from '@stayingupwind/core/paas';

/**
 * Where an application reads its storage from, defined by a process that is not a Function.
 *
 * A deployment's Function defines this symbol as its runtime is evaluated (`installResources` in
 * `@stayingupwind/runtime`), from the environment the platform handed it. A local run has neither,
 * so the CLI defines it — and it is defined in one place for both commands, because `upwind dev`
 * publishes in the process Next.js runs in and `upwind build` in the child it starts. Two
 * implementations would be two answers to "what does the application find", which is the question
 * this arrangement exists to have exactly one answer to.
 *
 * The rules are the Function's, for the same reasons: published once, not replaceable, not
 * removable, and built by `resourcesOf` from the manifest rather than assembled by hand here.
 */
export function publishResources(env: FunctionEnv): void {
  const key = Symbol.for(RESOURCES_SYMBOL_KEY);
  // Something in this process published first. What an application read a moment ago must not
  // become something else, so this is not an error and not an overwrite: it is nothing at all.
  if (Object.hasOwn(globalThis, key)) {
    return;
  }
  const published = resourcesOf(env);
  Object.defineProperty(globalThis, key, {
    configurable: false,
    enumerable: false,
    get: () => published,
  });
}
