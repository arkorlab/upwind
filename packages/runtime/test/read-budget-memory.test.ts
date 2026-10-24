import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

/**
 * Count promises after garbage collection in a separate process: a wait can outlast any of its
 * 20 ms re-checks, but none of those completed re-checks should stay alive until it ends. The
 * scope's projection budget has no deadline, so retaining each re-check grows without a bound.
 */
const PROBE = `
import { queryObjects } from 'node:v8';

const { IsolateRoom } = await import(process.argv[1]);
let now = 0;
let serial = 0;
const timers = new Map();
globalThis.setTimeout = (run, ms) => {
  const id = ++serial;
  timers.set(id, { run, due: now + ms });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);

async function advance(firings) {
  for (let count = 0; count < firings; count += 1) {
    let next;
    for (const entry of timers) {
      if (next === undefined || entry[1].due < next[1].due) next = entry;
    }
    if (next === undefined) throw new Error('the room stopped checking');
    timers.delete(next[0]);
    now = next[1].due;
    next[1].run();
    // Finish the current re-check before firing its next timer.
    for (let turns = 0; turns < 10; turns += 1) await Promise.resolve();
  }
}

const room = new IsolateRoom(1);
const release = room.takeAtOnce(1);
const calledOff = new AbortController();
const waiting = room.take(1, calledOff.signal).catch(() => {});
await advance(100);
const before = queryObjects(Promise);
await advance(2000);
const after = queryObjects(Promise);
calledOff.abort();
await waiting;
release();
console.log(JSON.stringify({ before, after }));
`;

/** Allow the handful of promises still used by the current re-check, however long it waited. */
const CURRENT_CHECK_PROMISES = 20;
const PROBE_TIMEOUT_MS = 10_000;

/** The Function and projection budgets use the same room, with bounded and unbounded waits. */
describe('the memory a room uses while a claim waits', () => {
  it('lets completed re-checks go while the claim keeps waiting', () => {
    const module = new URL('../../cache/src/isolate-room.ts', import.meta.url);
    const probe = spawnSync(
      process.execPath,
      ['--no-warnings', '--input-type=module', '-e', PROBE, module.href],
      {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      },
    );

    expect(probe.stderr).toBe('');
    expect(probe.status).toBe(0);

    const counts = JSON.parse(probe.stdout) as { readonly before: number; readonly after: number };

    expect(counts.after - counts.before).toBeLessThanOrEqual(CURRENT_CHECK_PROMISES);
  });
});
