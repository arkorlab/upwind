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

  it('stops at the stack, whatever follows it', () => {
    const message = `${snapshotFailure(['-   a', '+ a'])}\n-   not a change\n+ of the snapshot`;

    expect(indentationOnly(message)).toBe(true);
  });
});
