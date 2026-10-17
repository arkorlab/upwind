/**
 * What a rewrite's destination may be made of by what its rule captured: each `$1` or `$name` it
 * writes is filled in with a value the request brought (`replaceDestination`, in `@next/routing`),
 * and the path the router then sets on the URL resolves the dot segments it holds
 * (`applyDestination`). What the reference may hold is read off the rule's own pattern:
 *
 * - `segment`: one whole segment of the request's path (`:slug`, `([^/]+?)` between slashes);
 * - `segments`: whole segments of it (`:path+`, `:path*`);
 * - `part`: part of one segment (`:name.png`), which may be `.` or `..` and climb a level;
 * - `any`: anything — a value a `has` condition captured from the query, a header or a cookie, a
 *   pattern of the application's own (`:id(\d+)`), or a name the rule captures nothing under —
 *   which may hold `/` and `..`, and so make the path any path at all.
 *
 * The request's path is the URL's, dot segments resolved before the router matches a rule against
 * it: a whole segment of it is never `.` or `..`, and nor is a run of them.
 */

export type CaptureKind = 'segment' | 'segments' | 'part' | 'any';

/** A capturing group of a pattern: its name, if any, what it matches, and what stands around it. */
interface CaptureGroup {
  readonly name: string | undefined;
  readonly content: string;
  readonly before: string;
  readonly after: string;
}

/** A group as it was opened: whether it captures, under what name, and where its content starts. */
interface OpenGroup {
  readonly capturing: boolean;
  readonly name: string | undefined;
  readonly open: number;
  readonly contentStart: number;
}

/** A pattern as Next.js may write it: its slashes as they are, or escaped. */
function spellings(pattern: string): string[] {
  return [pattern, pattern.replaceAll('/', String.raw`\/`)];
}

/** What Next.js compiles a param of one whole segment to (`:slug`). */
const SEGMENT_PATTERNS: ReadonlySet<string> = new Set(
  ['[^/]+', '[^/]+?'].flatMap((pattern) => spellings(pattern)),
);
/** And a param of whole segments (`:path+`, `:path*`). */
const SEGMENTS_PATTERNS: ReadonlySet<string> = new Set(
  ['(?:[^/]+?)(?:/(?:[^/]+?))*'].flatMap((pattern) => spellings(pattern)),
);
/** A group that captures under a name: `(?<name>…`. */
const NAMED_OPENING = /^\(\?<(?<name>[A-Za-z_$][\w$]*)>/u;
/** A segment's own end in a pattern: the path's, a slash, or the next segment's group. */
const SEGMENT_END = /^(?:$|\$|\\\/|\/|\(\?:\\\/|\(\?:\/)/u;
/** What closes the wrapping groups a param is written in, and makes them optional. */
const WRAPPER_CLOSE = /^[)?]+/u;
/** A reference a destination makes to a capture: `$1`, `$slug`. */
const REFERENCE = /\$(?<reference>\w+)/gu;
const PLACE = /^\d+/u;

/** The group a `(` at `at` opens. */
function openGroup(pattern: string, at: number): OpenGroup {
  if (pattern[at + 1] !== '?') {
    return { capturing: true, name: undefined, open: at, contentStart: at + 1 };
  }
  const named = NAMED_OPENING.exec(pattern.slice(at));
  return named === null
    ? { capturing: false, name: undefined, open: at, contentStart: at }
    : {
        capturing: true,
        name: named.groups?.['name'],
        open: at,
        contentStart: at + named[0].length,
      };
}

/** Where a scan of a pattern is: the groups open, those closed, and whether it is in a class. */
interface Scan {
  readonly pattern: string;
  readonly opened: OpenGroup[];
  readonly closed: { readonly order: number; readonly group: CaptureGroup }[];
  readonly orderOf: Map<OpenGroup, number>;
  inClass: boolean;
}

/** The group a `)` at `at` closes, kept where it captures. */
function closeGroup(scan: Scan, at: number): void {
  const group = scan.opened.pop();
  const order = group === undefined ? undefined : scan.orderOf.get(group);
  if (group === undefined || order === undefined) {
    return;
  }
  const { pattern } = scan;
  const content = pattern.slice(group.contentStart, at);
  const around = { before: pattern.slice(0, group.open), after: pattern.slice(at + 1) };
  scan.closed.push({ order, group: { name: group.name, content, ...around } });
}

/** What the character at `at` does to the scan; the last character it read. */
function step(scan: Scan, at: number): number {
  const character = scan.pattern.charAt(at);
  if (character === '\\') {
    return at + 1;
  }
  if (scan.inClass) {
    scan.inClass = character !== ']';
    return at;
  }
  switch (character) {
    case '[': {
      scan.inClass = true;
      break;
    }
    case '(': {
      const group = openGroup(scan.pattern, at);
      if (group.capturing) {
        scan.orderOf.set(group, scan.orderOf.size);
      }
      scan.opened.push(group);
      break;
    }
    case ')': {
      closeGroup(scan, at);
      break;
    }
    default: {
      break;
    }
  }
  return at;
}

/** The capturing groups of a pattern, in the order their references count them (`$1`, `$2`). */
export function captureGroupsOf(pattern: string): CaptureGroup[] {
  const scan: Scan = { pattern, opened: [], closed: [], orderOf: new Map(), inClass: false };
  let at = 0;
  while (at < pattern.length) {
    at = step(scan, at) + 1;
  }
  return scan.closed.toSorted((one, other) => one.order - other.order).map(({ group }) => group);
}

/** Whether a group takes a segment from its start to its end, as Next.js writes a whole param. */
function wholeSegments(group: CaptureGroup): boolean {
  const starts = group.before.endsWith('/');
  return starts && SEGMENT_END.test(group.after.replace(WRAPPER_CLOSE, ''));
}

/** What a capturing group may hold (above). */
function kindOfGroup(group: CaptureGroup): CaptureKind {
  if (SEGMENT_PATTERNS.has(group.content)) {
    return wholeSegments(group) ? 'segment' : 'part';
  }
  return SEGMENTS_PATTERNS.has(group.content) && wholeSegments(group) ? 'segments' : 'any';
}

/** What a reference may hold, by the groups of the rule's pattern; `any` for one of none. */
function kindOfReference(reference: string, groups: readonly CaptureGroup[]): CaptureKind {
  const place = PLACE.exec(reference)?.[0];
  const group =
    place === undefined
      ? groups.find((each) => each.name === reference)
      : groups[Number(place) - 1];
  return group === undefined ? 'any' : kindOfGroup(group);
}

/** Each reference `path` makes to what a rule of pattern `sourceRegex` captured: where, and what. */
export function referencesOf(
  path: string,
  sourceRegex: string,
): { readonly at: number; readonly kind: CaptureKind }[] {
  const references = [...path.matchAll(REFERENCE)];
  if (references.length === 0) {
    return [];
  }
  const groups = captureGroupsOf(sourceRegex);
  return references.map((reference) => {
    return {
      at: reference.index,
      kind: kindOfReference(reference.groups?.['reference'] ?? '', groups),
    };
  });
}
