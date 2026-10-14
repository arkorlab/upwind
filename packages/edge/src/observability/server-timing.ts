/** One named duration of a `Server-Timing` header, with what it came from. */
export interface ServerTimingEntry {
  readonly name: string;
  readonly durationMs: number;
  readonly description?: string;
}

/** What a quoted string escapes with a backslash (RFC 9110 §5.6.4). */
const QUOTED_SPECIALS = /["\\]/gu;

/**
 * What a duration came from as a quoted string: its quotes and backslashes escaped, so that none
 * can end the string early and say more than the edge measured.
 */
function quoted(description: string): string {
  const escaped = description.replaceAll(QUOTED_SPECIALS, (special) => `\\${special}`);
  return `"${escaped}"`;
}

/** Build a `Server-Timing` header value from named durations. */
export function serverTiming(entries: readonly ServerTimingEntry[]): string {
  return entries
    .map((entry) => {
      const description =
        entry.description === undefined ? '' : `;desc=${quoted(entry.description)}`;
      return `${entry.name};dur=${entry.durationMs.toFixed(1)}${description}`;
    })
    .join(', ');
}
