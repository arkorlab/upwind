import type { OutputSnapshot } from '@stayingupwind/core/cache';

import type { TxInput } from './tx.ts';

/**
 * What a write to the ISR cache tells a host that meters it (`CacheMeter`): the bytes of the
 * generation the authority published, and whether the scope records its history
 * (`ScopeHistory.records`). Said once, by the call that published it, for the gateway to write
 * down: a commit said again answers with what it published and says nothing of it, and a value set
 * as it already was, or a regeneration whose output is the one it replaces, wrote nothing new.
 * Nothing here is awaited or read beyond the transaction the write is in.
 */
export interface IsrWrite {
  readonly bytes: number;
  readonly recorded: boolean;
}

/** The write a transaction just made, as metered: its bytes, and whether the scope records. */
export function isrWriteOf(input: Pick<TxInput, 'sql' | 'history'>, bytes: number): IsrWrite {
  return { bytes, recorded: input.history.records(input.sql) };
}

/**
 * Code-unit order, not a locale's: the two lists need only be sorted alike, and a collation may
 * pass over characters it deems ignorable and take two different lines for one.
 */
function byCodeUnits(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * The outputs as lines to compare: one for each output, what it is to the entry, and one for each
 * of its artifacts' bytes as their digests name them. The output's own line is there whether or
 * not it has artifacts, so that one without any — which a commit may publish — is weighed too.
 * Each line is its fields as JSON, which keeps a `null` pathname from an empty one and cannot run
 * one field into the next.
 */
function contentOf(outputs: readonly OutputSnapshot[]): string[] {
  return outputs
    .flatMap((output) => {
      const what = [output.representationKey, output.pathname, output.status];
      return [
        JSON.stringify(what),
        ...output.artifacts.map((artifact) =>
          JSON.stringify([...what, artifact.role, artifact.encoding, artifact.sha256]),
        ),
      ];
    })
    .toSorted(byCodeUnits);
}

/**
 * Whether a regeneration's outputs are the ones already current: the same representations, each
 * with the same pathname and status, and each of the same bytes by their digests — an output with
 * no bytes at all by the first two alone. What the response headers say is not weighed — a render
 * may stamp them afresh whatever it rendered — and neither is anything derived from the bytes.
 */
export function sameOutputs(
  next: readonly OutputSnapshot[],
  current: readonly OutputSnapshot[],
): boolean {
  const a = contentOf(next);
  const b = contentOf(current);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
