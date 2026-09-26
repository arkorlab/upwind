// Async — top-level await, for Turbopack — because the cache signal tracks a promise and nothing
// else: an ordinary module's import never reaches the timer the `cache-signal-timers` patch is about.
export const value = await Promise.resolve('loaded on demand');
