import type { BlobStore, KvSink } from './io.ts';

/**
 * How long each part of one change took, in milliseconds: what the gateway says on the change's
 * answer (`Server-Timing`), so that the time a write takes can be told apart into its parts where it
 * runs. A clock in a Worker moves with its I/O, which is what these parts wait on.
 *
 * Laps follow one another (`lap`). What a part waits on in KV and in storage is summed apart, with
 * how many calls it made (`timed`, `timedDeps`): a KV write refused for its key's second is made
 * again a second later (`writeKey`), and shows as a second call.
 */
export class Timing {
  readonly #laps: TimedPart[] = [];
  readonly #sums = new Map<string, { ms: number; calls: number }>();
  #mark = Date.now();

  /** The time since the last lap ended, or since the timing began, as `name`. */
  lap(name: string): void {
    const now = Date.now();
    this.#laps.push({ name, ms: now - this.#mark });
    this.#mark = now;
  }

  /** `work`, its time added to `name`'s, as one call more. */
  async timed<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work();
    } finally {
      const sum = this.#sums.get(name) ?? { ms: 0, calls: 0 };
      this.#sums.set(name, { ms: sum.ms + Date.now() - started, calls: sum.calls + 1 });
    }
  }

  /** Every lap, in order, then every sum. */
  get parts(): readonly TimedPart[] {
    return [
      ...this.#laps,
      ...[...this.#sums].map(([name, sum]) => ({ name, ms: sum.ms, calls: sum.calls })),
    ];
  }
}

/** One part of a change's time (`Timing`). */
export interface TimedPart {
  readonly name: string;
  readonly ms: number;
  /** How many calls a summed part was made of. */
  readonly calls?: number;
}

/** `deps`, with what its writes of KV and its reads of storage wait on summed into `timing`. */
export function timedDeps<D extends { readonly kv: KvSink; readonly blobs: BlobStore }>(
  deps: D,
  timing: Timing,
): D {
  const { kv, blobs } = deps;
  const timedKv: KvSink = {
    put: (key, value) => timing.timed('kv', () => kv.put(key, value)),
    delete: (key) => timing.timed('kv', () => kv.delete(key)),
    listPage: (input) => kv.listPage(input),
  };
  const timedBlobs: BlobStore = {
    ...blobs,
    read: (key) => timing.timed('storage-read', () => blobs.read(key)),
  };
  return { ...deps, kv: timedKv, blobs: timedBlobs };
}

/** `parts` as the value of a `Server-Timing` header, each name after `prefix`. */
export function serverTiming(parts: readonly TimedPart[], prefix = ''): string {
  return parts
    .map(({ name, ms, calls }) => {
      const desc = calls === undefined ? '' : `;desc="${String(calls)} calls"`;
      return `${prefix}${name};dur=${String(ms)}${desc}`;
    })
    .join(', ');
}
