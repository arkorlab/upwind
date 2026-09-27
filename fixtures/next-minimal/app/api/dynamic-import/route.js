import { connection } from 'next/server';

/**
 * A route handler loading an async module on demand. Under Cache Components every dynamic
 * `import()` is tracked on one `CacheSignal` per isolate, whose cancellation is what the
 * `cache-signal-timers` patch moves off a timer.
 */
export async function GET() {
  await connection();
  const { value } = await import('./async-module.js');
  return Response.json({ value });
}
