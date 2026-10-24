/**
 * A route handler that loads an async module on demand — the smallest thing found that reaches
 * the fault the `cache-signal-timers` patch answers. What makes it reach it is that
 * `src/lazy-payload.ts` has top-level await, so requiring it hands back a promise for Next.js to
 * track; importing an ordinary module here leaves nothing behind, and nor does importing this one
 * from a component while a page renders. `next/og` is a route handler too.
 */
export async function GET(): Promise<Response> {
  const { payload } = await import('../../../src/lazy-payload.ts');

  return Response.json(payload);
}
