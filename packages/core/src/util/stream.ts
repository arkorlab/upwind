/** Anything with a WHATWG-style `cancel()`: a `ReadableStream` or one of its readers. */
interface Cancellable {
  cancel(reason?: unknown): Promise<unknown>;
}

/**
 * Release an upstream body without waiting for it. The promise `cancel()` returns settles only when
 * the underlying source acknowledges the cancel, and a stalled origin socket may never do that; the
 * response must be closed (and recovery emitted) before, never after, this call.
 */
export function releaseStream(source: Cancellable | null | undefined, reason?: string): void {
  if (source === null || source === undefined) {
    return;
  }
  void source.cancel(reason).catch(() => {
    // Already closed, or never acknowledged: nothing else to release.
  });
}
