import { describe, expect, it } from 'vitest';

import { indentationOnly } from '../src/symptoms.ts';

/** An inline snapshot's failure, as Jest writes it: its diff, then the stack. */
function snapshotFailure(diff: readonly string[]): string {
  return [
    'Error: expect(received).toMatchInlineSnapshot(snapshot)',
    '',
    'Snapshot name: `build output 1`',
    '',
    '- Snapshot  - 2',
    '+ Received  + 2',
    '',
    ...diff,
    '    at Object.toMatchInlineSnapshot (/home/runner/work/upwind/upwind/nextjs/test/e2e/app-dir/x/x.test.ts:10:5)',
  ].join('\n');
}

describe('a snapshot whose lines differ in their indentation alone', () => {
  it('is read so where only the indentation changed', () => {
    expect(indentationOnly(snapshotFailure(['-   a', '+ a', '-   b', '+ b']))).toBe(true);
  });

  /** cubic: an unchanged line that begins with `at` was taken for the stack, hiding what followed. */
  it('is not read so where a line after an unchanged `at` line changed', () => {
    const diff = ['-   a', '+ a', '    at the build step', '-   b', '+ c'];

    expect(indentationOnly(snapshotFailure(diff))).toBe(false);
  });

  /** cubic: a line that merely ends like a location is not a frame either. */
  it.each([
    '    at the build step:12:34',
    '      at Object.<anonymous> (/home/runner/app/build.js:3:9)',
  ])('is not read so where a change follows the unchanged line %j', (unchanged) => {
    const diff = ['-   a', '+ a', unchanged, '-   b', '+ c'];

    expect(indentationOnly(snapshotFailure(diff))).toBe(false);
  });

  it.each([
    '    at Object.toMatchInlineSnapshot (/home/runner/x.test.ts:10:5)',
    '    at /home/runner/x.test.ts:10:5',
    '    at processTicksAndRejections (node:internal/process/task_queues:104:5)',
    '    at file:///home/runner/x.test.mjs:10:5',
  ])('ends the diff at the frame %j', (frame) => {
    // The frame comes before a change, which only it can leave out.
    expect(indentationOnly(snapshotFailure(['-   a', '+ a', frame, '-   b', '+ c']))).toBe(true);
  });

  it('stops at the stack, whatever follows it', () => {
    const message = `${snapshotFailure(['-   a', '+ a'])}\n-   not a change\n+ of the snapshot`;

    expect(indentationOnly(message)).toBe(true);
  });
});
