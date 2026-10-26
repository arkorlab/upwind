/**
 * The answers that go out with the length they state, cache writes or not (`withWritesLanded`): a
 * shipped file a host sends as the edge sends one (`native/static-file.ts`). The edge answers a file
 * with its length whatever else the request handed over — it is the same bytes to every visitor,
 * read from storage, and nothing of it waits on a write — and the native target is to answer as the
 * edge does.
 *
 * Kept by the answer itself rather than said in a header: nothing a rule of `next.config` or a
 * middleware sets can claim it. An answer made again of one (`new Response(body, answer)`) is not
 * among them, and goes out as any other: without its length.
 */
const keptLengths = new WeakSet<Response>();

/** `response`, to go out with the length it states. */
export function keepsItsLength(response: Response): Response {
  keptLengths.add(response);
  return response;
}

/** Whether `response` goes out with the length it states (`keepsItsLength`). */
export function keptItsLength(response: Response): boolean {
  return keptLengths.has(response);
}
