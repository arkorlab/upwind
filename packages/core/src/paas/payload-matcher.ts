import { PatternBudgetExceededError, testWithin } from '../request/pattern-budget.ts';
import { type Alternatives, parseAlternatives } from '../request/pattern-tree.ts';

/**
 * A middleware matcher of Next.js 16.4's, tested a part at a time where the edge would not test it
 * whole.
 *
 * Next.js 16.4 ends every matcher but the root's with the payloads a page has
 * (`get-page-static-info.ts`): its data route's `.json`, its RSC payload, and a segment of it
 * (`.segments/…/….segment.rsc`), then the one separator `path-to-regexp` allows. After a parameter
 * whose characters can include a `.`, the cost model reads that end as one more degree for each
 * repetition before it — `/:locale/:path*` as quartic, tested against nine characters at most — and
 * the edge handed nearly every request to the application's Function before its middleware, a static
 * file's among them, which the Function has none of to serve. V8 runs such a matcher in quadratic
 * time against the worst values found.
 *
 * Where the matcher is anchored and nothing before its end reads past the characters it matches — no
 * lookaround, no assertion but its first `^`, no backreference — whether it matches a path is whether
 * the path splits into a head, a payload and a separator, each as the matcher allows, with the
 * matcher before its end (`^…$`, linear for every matcher Next.js writes) matching the head. The
 * payloads a path can end with are few: none, `.json`, `.rsc`, or a segment beginning at one of the
 * places `.segments/` is, so each head is tested on its own, held to the budget as any test is. A
 * path with more such places than `MAX_SEGMENT_STARTS` is not split at all.
 */

/** The end Next.js 16.4 gives a matcher of any path but the root, as `path-to-regexp` writes it. */
const PAYLOAD_END = String.raw`(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$`;
const SEPARATORS = '/#?';
const DATA = '.json';
const RSC = '.rsc';
const SEGMENTS = '.segments/';
const SEGMENT = '.segment.rsc';
/** What `.` does not take, without the `s` flag Next.js does not compile a matcher with. */
const LINE_TERMINATOR = /[\n\r\u{2028}\u{2029}]/u;
/** More places a segment could begin than any path a page's payload is asked by has. */
const MAX_SEGMENT_STARTS = 16;
const UPPER_CASE = /[A-Z]/gu;

/** Each matcher's head, or `null` for one that is not split, worked out the first time it is needed. */
const heads = new WeakMap<RegExp, RegExp | null>();

/** Whether one node reads nothing but the characters it matches, at `index` of a sequence `length` long. */
function nodeReadsOnlyItself(
  node: Alternatives[number][number],
  index: number,
  length: number,
  outermost: boolean,
): boolean {
  if (node.kind === 'anchor') {
    return (
      outermost &&
      ((node.at === 'start' && index === 0) || (node.at === 'end' && index === length - 1))
    );
  }
  if (node.kind === 'look') {
    return false;
  }
  return node.kind === 'atom' || readsOnlyItself(node.alternatives, false);
}

/** Whether a pattern's nodes read nothing but the characters they match, past its own two anchors. */
function readsOnlyItself(alternatives: Alternatives, outermost: boolean): boolean {
  return alternatives.every((sequence) =>
    sequence.every((node, index) => nodeReadsOnlyItself(node, index, sequence.length, outermost)),
  );
}

/** The matcher before its payload end, as a pattern of its own (`^…$`); `null` where it is not split. */
function headOf(pattern: RegExp): RegExp | null {
  let head = heads.get(pattern);
  if (head === undefined) {
    head = null;
    const { source, flags } = pattern;
    if (source.startsWith('^') && source.endsWith(PAYLOAD_END)) {
      const own = `${source.slice(0, -PAYLOAD_END.length)}$`;
      const alternatives = parseAlternatives(own, 0, own.length);
      if (alternatives?.length === 1 && readsOnlyItself(alternatives, true)) {
        // eslint-disable-next-line security/detect-non-literal-regexp -- a matcher's own source, compiled as Next.js compiled it
        head = new RegExp(own, flags);
      }
    }
    heads.set(pattern, head);
  }
  return head;
}

/**
 * The heads of `path` before a segment that ends at `end` — one for each place `.segments/` begins
 * with a name of one character or more after it — read off `folded`, the path as `i` folds it;
 * `undefined` past `MAX_SEGMENT_STARTS` of them.
 */
function segmentHeads(path: string, folded: string, end: number): string[] | undefined {
  const stop = end - SEGMENT.length;
  // A segment's name runs to `stop` and holds no line terminator, so it begins past the last one
  // before `stop`: found once, rather than read again for each place `.segments/` begins.
  let after = stop;
  while (after > 0 && !LINE_TERMINATOR.test(folded[after - 1] ?? '')) {
    after -= 1;
  }
  const found: string[] = [];
  for (
    let at = folded.indexOf(SEGMENTS);
    at !== -1 && at < stop;
    at = folded.indexOf(SEGMENTS, at + 1)
  ) {
    const name = at + SEGMENTS.length;
    if (name >= stop || name < after) {
      continue;
    }
    if (found.length === MAX_SEGMENT_STARTS) {
      return undefined;
    }
    found.push(path.slice(0, at));
  }
  return found;
}

/** The heads a path splits into before a payload and a separator; `undefined` for one with too many. */
function headsOf(path: string, ignoresCase: boolean): string[] | undefined {
  // Folded as `i` folds them without `u`: ASCII letters, and only those, which keeps every length.
  const folded = ignoresCase ? path.replaceAll(UPPER_CASE, (letter) => letter.toLowerCase()) : path;
  // An empty path ends in no separator: `includes('')` would say it does.
  const last = folded.at(-1);
  const ends =
    last !== undefined && SEPARATORS.includes(last)
      ? [folded.length, folded.length - 1]
      : [folded.length];
  const found: string[] = [];
  for (const end of ends) {
    const before = folded.slice(0, end);
    found.push(path.slice(0, end));
    for (const payload of [DATA, RSC]) {
      if (before.endsWith(payload)) {
        found.push(path.slice(0, end - payload.length));
      }
    }
    const segments = before.endsWith(SEGMENT) ? segmentHeads(path, before, end) : [];
    if (segments === undefined) {
      return undefined;
    }
    found.push(...segments);
  }
  return found;
}

/**
 * Whether the head matches any of the ways the path splits. One it is not allowed against is not a
 * no: another way may still hold, which is a yes whatever the others are, and only where none holds
 * is the first refusal what is answered.
 */
function someHeadHolds(head: RegExp, split: readonly string[]): boolean {
  let refused: PatternBudgetExceededError | undefined;
  for (const candidate of split) {
    try {
      if (testWithin(head, candidate)) {
        return true;
      }
    } catch (error) {
      if (!(error instanceof PatternBudgetExceededError)) {
        throw error;
      }
      refused ??= error;
    }
  }
  if (refused !== undefined) {
    throw refused;
  }
  return false;
}

/**
 * `pattern.test(path)` for a middleware's matcher, within what a test is allowed (`testWithin`): the
 * matcher whole where that is, and otherwise, for one of Next.js 16.4's, the head of each way the path
 * splits. `PatternBudgetExceededError` where neither is allowed.
 */
export function matcherHolds(pattern: RegExp, path: string): boolean {
  try {
    return testWithin(pattern, path);
  } catch (error) {
    const head = error instanceof PatternBudgetExceededError ? headOf(pattern) : null;
    const split = head === null ? undefined : headsOf(path, pattern.flags.includes('i'));
    if (head === null || split === undefined) {
      throw error;
    }
    return someHeadHolds(head, split);
  }
}
