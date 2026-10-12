/** One named duration of a `Server-Timing` header, with what it came from. */
export interface ServerTimingEntry {
  readonly name: string;
  readonly durationMs: number;
  readonly description?: string;
}

/** Build a `Server-Timing` header value from named durations. */
export function serverTiming(entries: readonly ServerTimingEntry[]): string {
  return entries
    .map((entry) => {
      const description = entry.description === undefined ? '' : `;desc="${entry.description}"`;
      return `${entry.name};dur=${entry.durationMs.toFixed(1)}${description}`;
    })
    .join(', ');
}
