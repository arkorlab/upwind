/**
 * The hook the runtime has to load exactly once, before any request: it leaves a mark a route
 * reads back, and counts how often it ran.
 */
export function register(): void {
  Reflect.set(globalThis, 'fixtureInstrumented', (globalThis.fixtureInstrumented ?? 0) + 1);
}
