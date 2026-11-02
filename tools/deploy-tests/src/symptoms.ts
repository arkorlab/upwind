/**
 * What the judge reads a reviewed case's failure messages by (`reviewed.ts`): each message must answer
 * to its reading's symptom, so a case that fails in another way is read again.
 */

/** What a reviewed failure looks like: each of the case's failure messages must answer to it. */
export type Symptom = (message: string) => boolean;

/** A message that answers to any of `symptoms`: a case that fails one of a few recorded ways. */
export function anyOf(...symptoms: readonly Symptom[]): Symptom {
  return (message) => symptoms.some((symptom) => symptom(message));
}

/** A message that holds each of `parts`, in that order. */
export function inOrder(...parts: readonly string[]): Symptom {
  return (message) => {
    let from = 0;
    for (const part of parts) {
      const at = message.indexOf(part, from);
      if (at === -1) {
        return false;
      }
      from = at + part.length;
    }
    return true;
  };
}

const HEADER_NULL = /Expected: "(?:HIT|MISS|PRERENDER)"\nReceived: null\n/u;

/**
 * A response header the test reads, which is not there: `toBe(…)` given `null`, thrown at one of
 * `lines` of `file`.
 */
export function headerMissing(file: string, lines: readonly string[]): Symptom {
  return (message) => {
    const thrownAt = message.split('\n').find((line) => line.trimStart().startsWith('at '));
    return (
      HEADER_NULL.test(message) &&
      thrownAt !== undefined &&
      lines.some((line) => thrownAt.includes(`${file}:${line}:`))
    );
  };
}

/** The lines an inline snapshot's failure marks removed and added, in order. */
function snapshotChanges(
  message: string,
): { readonly removed: readonly string[]; readonly added: readonly string[] } | undefined {
  const lines = message.split('\n');
  const start = lines.findIndex((line) => line.startsWith('+ Received'));
  if (
    start === -1 ||
    !message.includes('toMatchInlineSnapshot') ||
    lines[start - 1]?.startsWith('- Snapshot') !== true
  ) {
    return undefined;
  }
  const diff = lines.slice(start + 1);
  const end = diff.findIndex((line) => /^\s+at /u.test(line));
  const changed = end === -1 ? diff : diff.slice(0, end);
  const removed: string[] = [];
  const added: string[] = [];
  // An empty line is marked by its sign alone, with no space after it.
  for (const line of changed) {
    if (line === '-' || line.startsWith('- ')) {
      removed.push(line.slice(2));
    } else if (line === '+' || line.startsWith('+ ')) {
      added.push(line.slice(2));
    }
  }
  return { removed, added };
}

/**
 * An inline snapshot that differs from what was received in each line's leading whitespace and in
 * nothing else: the lines Jest marks removed and added, in order, are the same once that is taken
 * off.
 */
export function indentationOnly(message: string): boolean {
  const changes = snapshotChanges(message);
  const removed = changes?.removed.map((line) => line.trimStart()) ?? [];
  const added = changes?.added.map((line) => line.trimStart()) ?? [];
  return removed.length > 0 && removed.join('\n') === added.join('\n');
}

/** An inline snapshot that differs from what was received in exactly these lines. */
export function snapshotDiffers(removed: readonly string[], added: readonly string[]): Symptom {
  return (message) => {
    const changes = snapshotChanges(message);
    return (
      changes?.removed.join('\n') === removed.join('\n') &&
      changes.added.join('\n') === added.join('\n')
    );
  };
}

/**
 * A URL Vercel's build directory was expected in, received for the same file in another: what
 * follows `file:///vercel/path0/` is the end of what was received, encoding and all.
 */
export function inAnotherDirectory(message: string): boolean {
  const expected = /Expected: "file:\/\/\/vercel\/path0\/([^"]+)"/u.exec(message)?.[1];
  const received = /Received: "(file:\/\/\/[^"]+)"/u.exec(message)?.[1];
  return expected !== undefined && received?.endsWith(`/${expected}`) === true;
}
