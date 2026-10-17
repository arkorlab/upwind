import { describe, expect, it } from 'vitest';

import { serverTiming } from '../src/observability/server-timing.ts';

/** A `Server-Timing` value: each duration by its name, and what it came from as a quoted string. */
describe('a Server-Timing value', () => {
  it('names each duration, and what it came from', () => {
    const value = serverTiming([
      { name: 'ptr', durationMs: 1 },
      { name: 'shell', durationMs: 2.5, description: 'kv' },
    ]);

    expect(value).toBe('ptr;dur=1.0, shell;dur=2.5;desc="kv"');
  });

  it('escapes the quotes and backslashes of what a duration came from', () => {
    const value = serverTiming([{ name: 'shell', durationMs: 1, description: String.raw`a"b\c` }]);

    expect(value).toBe(String.raw`shell;dur=1.0;desc="a\"b\\c"`);
  });
});
