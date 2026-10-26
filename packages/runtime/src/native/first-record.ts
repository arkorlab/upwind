import { nowMs } from '../cache/clock.ts';
import { type CurrentGeneration, currentGeneration } from '../cache/current.ts';
import type { FirstPublish } from '../delivery.ts';
import type { RoutedInput } from '../serve.ts';

/**
 * How the first data of a member waits for the member's first generation on the native target
 * (`offeredOncePublished`, `delivery.ts`), as the edge's capture of it waits (`static-page-capture.ts`):
 * within one window, while the visitor stays, the record read on the edge's schedule.
 */

/**
 * How long the first data of a member waits for its generation, from the answer made: the edge's
 * own window (`FOREGROUND_RECORD_READ_MS`, `static-page-capture.ts`), which it opens once the
 * Function's answer is in.
 */
export const FIRST_RECORD_MS = 10_000;
/** How many times the record is read meanwhile, at the most (`MAX_FIRST_MEMBER_READS`). */
const FIRST_RECORD_READS = 6;
/** The pause before the second read, doubled before each after it (`FIRST_MEMBER_RETRY_MS`). */
const FIRST_RECORD_RETRY_MS = 250;

/** `operation`'s value, held so that a value of `undefined` is told from none. */
async function valued<T>(operation: Promise<T>): Promise<{ readonly value: T }> {
  return { value: await operation };
}

/** `operation`'s value, or `undefined` once the window closes or the visitor goes first. */
export async function within<T>(
  operation: Promise<T>,
  until: number,
  signal: AbortSignal,
): Promise<{ readonly value: T } | undefined> {
  const remaining = until - performance.now();
  if (remaining <= 0 || signal.aborted) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      valued(operation),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, remaining);
        onAbort = () => {
          resolve(undefined);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/** Whether a pause of `milliseconds` ran its course, the window open and the visitor still there. */
async function pausedFor(
  milliseconds: number,
  until: number,
  signal: AbortSignal,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const paused = await within(
      new Promise<true>((resolve) => {
        timer = setTimeout(() => {
          resolve(true);
        }, milliseconds);
      }),
      until,
      signal,
    );
    return paused !== undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a publish settled as a generation (`PublishOutcome`): one refused or failed may not be. */
function publishedOne(settled: unknown): boolean {
  return (
    typeof settled === 'object' &&
    settled !== null &&
    (settled as { readonly kind?: unknown }).kind === 'published'
  );
}

/**
 * The entry's generation once there is one, within the window and while the visitor stays.
 *
 * The publish this isolate makes is waited for first, as the edge waits for the Function's answer,
 * which waits for it (`holdFirstPublish`) — bounded here, where the edge's wait is the Function's
 * own: a cache that stalls keeps no visitor from the answer made for them. A publish that settled
 * any other way than as a generation leaves one read: the commit may have landed all the same, or
 * another attempt's in its place, and the record says which. Otherwise the record is read as the
 * edge reads it for a first member (`confirmedPairedPage`): again while it is absent, after a pause
 * doubled each time, a few times at the most.
 */
export async function firstRecord(
  input: RoutedInput,
  first: FirstPublish,
  until: number,
): Promise<CurrentGeneration | undefined> {
  const { signal } = input.request;
  let reads = FIRST_RECORD_READS;
  if (first.published !== undefined) {
    const settled = await within(first.published, until, signal);
    if (settled === undefined) return undefined;
    if (!publishedOne(settled.value)) reads = 1;
  }
  let delay = FIRST_RECORD_RETRY_MS;
  for (let read = 1; ; read += 1) {
    const lookup = await within(
      currentGeneration(first.runtime, first.descriptor, nowMs(), input.waitUntil),
      until,
      signal,
    );
    if (lookup === undefined) return undefined;
    if (lookup.value.kind === 'generation') return lookup.value.current;
    if (read >= reads || !(await pausedFor(delay, until, signal))) return undefined;
    delay *= 2;
  }
}

/** An answer nobody waits for any more, let go of once it comes: its body is never read. */
export async function letGo(reading: Promise<Response | undefined>): Promise<void> {
  try {
    await (await reading)?.body?.cancel();
  } catch {
    // Its read failed: there is nothing to let go of.
  }
}
