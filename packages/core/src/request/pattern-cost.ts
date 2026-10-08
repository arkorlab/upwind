import { caseVariants, delimitedRepetition } from './pattern-repetition.ts';
import type { Atom } from './pattern-syntax.ts';
import {
  type Alternatives,
  type Counted,
  nestingDepth,
  parseAlternatives,
  type PatternNode,
} from './pattern-tree.ts';

/**
 * What it may cost to run a routing pattern against a value, and how long a value the edge runs it
 * against.
 *
 * The edge runs an application's patterns — its routes, its middleware's matchers, the `has` and
 * `missing` conditions of both — against pathnames, headers, cookies and query values a visitor
 * chose, on a Function every other application shares. The upload refuses the patterns that
 * backtrack exponentially (`unsafeRoutePatternReason`); it admits those that backtrack
 * polynomially, to a degree the application picks. `.*.*.*.*!` is quartic in the value's length,
 * and costs tens of milliseconds against a browser's own user agent; `\w+\w+!`, tried anywhere in a
 * value, is cubic, and costs seconds against a few kilobytes. V8 cannot interrupt a match once it
 * has begun.
 *
 * So the cost of a test is bounded before it is run: read off the pattern's shape as an upper bound
 * in steps, a polynomial in the value's length `n`, and the test run only where that bound is within
 * `BUDGET`. Where it is not — a pattern this cannot read, or a value longer than the bound affords —
 * the test is not run at all (`PatternBudgetExceededError`), and the edge hands the request to the
 * application's own Function, which routes it as Next.js does at no one else's expense. Bounded
 * only where a caller asks for it (`budgetPatterns`): the edge does, and an application's own
 * Function, which runs the same code for itself, does not.
 *
 * The degree counts the repetitions the engine may revisit with another length: each repetition
 * multiplies what follows it by the value's length, as a backtracking engine tries each of its
 * lengths in turn for what comes after. Two shapes revisit nothing, and are counted as such:
 *
 * - A repetition whose end is forced: where every character that can follow it is one it cannot
 *   consume — `[^/]+` before a `/`, or before the value's end. Given back a character, it leaves one
 *   nothing after it can begin with, so what follows is tried from one place; its own scan is
 *   counted, and what follows is not multiplied.
 * - A `.*` that takes the rest of the value, where everything after it can match nothing at the
 *   value's end: once reached, the match succeeds. Only for a value with no line terminator, all
 *   of whose characters `.` takes.
 *
 * Next.js's routes and matchers are linear in this count: their parameters are forced by the slash
 * after them, their catch-alls by the end, and their matchers end in `.*` with only optional parts
 * after it. Each part of the pattern adds what it does each time it is reached, in steps measured on
 * V8 (`REPEATED_STEPS` and the rest), so that a long pattern costs what its length does; a choice
 * between alternatives, of an optional part or of a count multiplies what follows instead.
 */

/** A pattern's cost as an upper bound in steps, a polynomial in its value's length `n`. */
export interface PatternCost {
  /** The highest power of the value's length the cost grows with. */
  readonly degree: number;
  /** `terms[d]` steps for each `n^d`. */
  readonly terms: readonly number[];
}

/**
 * The steps a test is allowed: about a millisecond, as measured for every shape this was checked
 * with, each against the longest value it allows. At it, a quadratic pattern runs against some 700
 * characters, a cubic one against 80, a quartic one against 25 — a user agent, past those, is left
 * to the application's Function — and a linear one against tens or hundreds of thousands.
 */
const BUDGET = 524_288;
/**
 * A step: a character a repetition takes and gives back, measured at about a nanosecond and a half
 * on V8 (`a+b`, tried anywhere in a run of `a`).
 */
const REPEATED_STEPS = 1;
/**
 * A place to come back to — an alternative, an optional part, a count — made, and taken: about a
 * step (`(?:a|a)` in a row, against a value that fails at its end).
 */
const CHOICE_STEPS = 1;
/**
 * A repetition a counted quantifier takes, which V8 runs as a loop with a counter: about three
 * nanoseconds (`[a-z]{64}` tried anywhere in a run of letters).
 */
const COUNTED_STEPS = 2;
/**
 * A character tested against an atom on its own, which V8 compares several at a time: a sixteenth of
 * a step, under a tenth of a nanosecond (`(?:a…a|a…ab)c`, hundreds of letters long, tried anywhere
 * in a run of `a`).
 */
const ATOM_STEPS = 0.0625;
/**
 * The most repetitions a counted quantifier may take and still be read as a choice among that many
 * — `[a-z]{2}`, `\d{2,4}` — rather than as a repetition that grows with the value.
 */
const MAX_COUNTED = 64;
/**
 * The highest degree read: past it, a test affords a value of two characters at most, and the pattern
 * is read as one whose cost this does not bound. Reading it costs its length times this.
 */
const MAX_DEGREE = 16;
/**
 * More ways through a pattern than a test could ever take: past it the count is held, as whatever
 * the ways lead to is already reached more times than the budget has steps.
 */
const MAX_WAYS = 1_125_899_906_842_624;
/** Longer than any value a request carries: a test that affords it affords any. */
const MAX_VALUE_LENGTH = 4_294_967_296;
/** Flags this does not read: `m`, under which `^` and `$` hold at every line; `v`, whose sets nest. */
const UNREAD_FLAGS = /[mv]/u;
/** Longer than any pattern the upload admits; past it nothing is read. */
const MAX_ANALYZED_LENGTH = 4096;
/**
 * Deeper than any pattern Next.js writes nests its groups, a few levels at most; past it nothing is
 * read, so that reading a pattern recurses no further than this does.
 */
const MAX_NESTING = 32;
/** The characters `.` does not take, without the `s` flag. */
const LINE_TERMINATOR = /[\n\r\u{2028}\u{2029}]/u;

/**
 * A test the edge did not run: its pattern's cost against the value is past what a test is allowed
 * (`BUDGET`), or not one this can bound. Not a non-match: the caller hands the request to the
 * application's Function, which routes it itself.
 */
export class PatternBudgetExceededError extends Error {
  readonly source: string;
  readonly valueLength: number;

  constructor(
    tested: { readonly source: string; readonly valueLength: number },
    options?: ErrorOptions,
  ) {
    super(
      `a pattern of ${String(tested.source.length)} characters against a value of ${String(tested.valueLength)}`,
      options,
    );
    this.name = 'PatternBudgetExceededError';
    this.source = tested.source;
    this.valueLength = tested.valueLength;
  }
}

const budget = { on: false };

/**
 * Bound every test of a routing pattern from here on (`testWithin`, `execWithin`): what the edge
 * asks for before it routes a request.
 *
 * Off until a host asks, because only a host that runs the patterns of applications it does not own
 * — against values their visitors chose, on a Function they all share — has a reason to. A server of
 * one application, its own Function among them, tests that application's patterns as Next.js does,
 * with nothing to hand a request it would not test to.
 *
 * Asked once per isolate, and for good: the bound is the isolate's, not a caller's. So an isolate
 * that asks is one that routes for an edge and nothing else. Where a test is past the bound, every
 * function here throws (`PatternBudgetExceededError`) for its caller to hand the request on — and
 * the runtime asks the same functions for an answer, with no Function behind it to hand anything to.
 */
export function budgetPatterns(): void {
  budget.on = true;
}

/**
 * Where what follows a node ends, and succeeds: the pattern's end, where the match does, or a
 * lookaround's, where the lookaround does and the match goes on — never to be tried again, as a
 * lookaround is never backtracked into. With the degree of the number of times it is reached.
 */
interface Context {
  readonly kind: 'pattern' | 'lookahead' | 'lookbehind';
  readonly entry: number;
}

/** The characters what follows can begin with, or `any` where it is not a set of literals. */
interface First {
  readonly chars: readonly string[];
  readonly any: boolean;
}

/**
 * What follows a node, to the end of its context: the characters it can begin with, and whether it
 * can match nothing — anywhere, or at the value's end, where a `$` holds. Worked out once for each
 * node, from the end of its sequence back, so that reading a pattern costs its length.
 */
interface After {
  readonly first: First;
  readonly emptyAnywhere: boolean;
  readonly emptyAtEnd: boolean;
  readonly context: Context;
}

/** One node's first characters, and whether it can match nothing and let what follows begin. */
interface NodeFirst extends First {
  readonly nullable: boolean;
}

const ANY: NodeFirst = { chars: [], any: true, nullable: false };
const NOTHING: NodeFirst = { chars: [], any: false, nullable: true };
/** The value's end, after which nothing is consumed: a set of no characters. */
const AT_END: NodeFirst = { chars: [], any: false, nullable: false };
/** More first characters than this are read as any. */
const MAX_FIRST_CHARS = 256;

function variantsOf(character: string, flags: string): readonly string[] | undefined {
  return flags.includes('i') ? caseVariants(character) : [character];
}

function sequenceFirst(nodes: readonly PatternNode[], flags: string): NodeFirst {
  const chars: string[] = [];
  for (const node of nodes) {
    const first = nodeFirst(node, flags);
    if (first.any || chars.length + first.chars.length > MAX_FIRST_CHARS) {
      return ANY;
    }
    chars.push(...first.chars);
    if (!first.nullable) {
      return { chars, any: false, nullable: false };
    }
  }
  return { chars, any: false, nullable: true };
}

const nodeFirsts = new WeakMap<PatternNode, NodeFirst>();

function nodeFirst(node: PatternNode, flags: string): NodeFirst {
  const known = nodeFirsts.get(node);
  if (known !== undefined) {
    return known;
  }
  const first = readFirst(node, flags);
  nodeFirsts.set(node, first);
  return first;
}

function readFirst(node: PatternNode, flags: string): NodeFirst {
  switch (node.kind) {
    case 'anchor': {
      return node.at === 'end' ? AT_END : NOTHING;
    }
    case 'look': {
      // It consumes nothing, and only narrows what follows: what follows begins as it would.
      return NOTHING;
    }
    case 'atom': {
      const variants = node.literal === undefined ? undefined : variantsOf(node.literal, flags);
      return variants === undefined
        ? ANY
        : { chars: variants, any: false, nullable: node.quantifier?.min === 0 };
    }
    case 'group': {
      const chars: string[] = [];
      let nullable = node.quantifier?.min === 0;
      for (const alternative of node.alternatives) {
        const first = sequenceFirst(alternative, flags);
        if (first.any || chars.length + first.chars.length > MAX_FIRST_CHARS) {
          return ANY;
        }
        chars.push(...first.chars);
        nullable ||= first.nullable;
      }
      return { chars, any: false, nullable };
    }
  }
}

/**
 * Whether a node can match nothing where the repetition before it stopped: anywhere, or — `$` —
 * only at the value's end (`atEnd`).
 */
function matchesNothing(node: PatternNode, atEnd: boolean): boolean {
  switch (node.kind) {
    case 'anchor': {
      return atEnd && node.at === 'end';
    }
    case 'look': {
      // One that holds wherever its alternatives can match nothing: positive, and with one such.
      return (
        !node.negative &&
        node.alternatives.some((alternative) =>
          alternative.every((inner) => matchesNothing(inner, atEnd)),
        )
      );
    }
    case 'atom': {
      return node.quantifier?.min === 0;
    }
    case 'group': {
      return (
        node.quantifier?.min === 0 ||
        node.alternatives.some((alternative) =>
          alternative.every((inner) => matchesNothing(inner, atEnd)),
        )
      );
    }
  }
}

/** What follows the node before `after`: `node`, and then `after`. */
function prepended(node: PatternNode, after: After, flags: string): After {
  const first = nodeFirst(node, flags);
  let joined: First;
  if (first.any) {
    joined = ANY;
  } else if (!first.nullable) {
    joined = first;
  } else if (after.first.any || first.chars.length + after.first.chars.length > MAX_FIRST_CHARS) {
    joined = ANY;
  } else {
    joined = { chars: [...first.chars, ...after.first.chars], any: false };
  }
  return {
    first: joined,
    emptyAnywhere: after.emptyAnywhere && matchesNothing(node, false),
    emptyAtEnd: after.emptyAtEnd && matchesNothing(node, true),
    context: after.context,
  };
}

/** What follows the end of a context: anything, and nothing at all, which matches anywhere. */
function contextEnd(context: Context): After {
  return { first: ANY, emptyAnywhere: true, emptyAtEnd: true, context };
}

/** Whether a repetition of `atom` must stop where the first character it cannot consume is. */
function forced(atom: Atom, after: After): boolean {
  return !after.first.any && after.first.chars.every((character) => !atom.matches(character));
}

interface Reading {
  readonly flags: string;
  /** The value has no line terminator, so `.` takes each of its characters. */
  readonly lineFree: boolean;
}

/**
 * Whether reaching a repetition is its context succeeding (`Context`): it can take nothing, and all
 * that follows it to the context's end can match nothing wherever it stops — or, past a `$`, where a
 * `.*` that takes the rest of the value stops. Reached once, then, for each time the context is: the
 * engine stops there, and never comes back. Not in a lookbehind, which the engine matches from its
 * end backwards.
 */
function endsItsContext(
  node: Extract<PatternNode, { kind: 'atom' }>,
  after: After,
  reading: Reading,
): boolean {
  if (node.quantifier?.min !== 0 || after.context.kind === 'lookbehind') {
    return false;
  }
  return node.dot && reading.lineFree ? after.emptyAtEnd : after.emptyAnywhere;
}

/** A cost in steps, as a polynomial in the value's length `n`: `terms[d]` steps for each `n^d`. */
type Terms = readonly number[];

/** `steps` for each `n^power`. */
function term(power: number, steps: number): Terms {
  return Array.from({ length: power + 1 }, (_, at) => (at === power ? steps : 0));
}

/** `terms`, taken `times` over, added to `into`. */
function addInto(into: number[], terms: Terms, times: number): void {
  for (const [power, steps] of terms.entries()) {
    into[power] = (into[power] ?? 0) + steps * times;
  }
}

/**
 * A node's cost: what it does itself (`terms`), and the degree of the number of times what follows
 * it is reached (`exit`), for each way it is reached — `n^entry` times — itself.
 */
interface Cost {
  readonly exit: number;
  /** The ways through the node what follows it is reached by. */
  readonly factor: number;
  readonly terms: Terms;
}

function sequenceCost(
  nodes: readonly PatternNode[],
  entry: number,
  after: After,
  reading: Reading,
): Cost | undefined {
  // What follows each node, worked out from the end back.
  const follows: After[] = [];
  let next = after;
  for (const node of nodes.toReversed()) {
    follows.push(next);
    next = prepended(node, next, reading.flags);
  }
  follows.reverse();
  const terms: number[] = [];
  let current = entry;
  let factor = 1;
  for (const [index, node] of nodes.entries()) {
    const cost =
      current < MAX_DEGREE ? nodeCost(node, current, follows[index] ?? after, reading) : undefined;
    if (cost === undefined) {
      return undefined;
    }
    // Reached by each way through what comes before it.
    addInto(terms, cost.terms, factor);
    current = cost.exit;
    factor = Math.min(factor * cost.factor, MAX_WAYS);
  }
  return { exit: current, factor, terms };
}

/**
 * Whether no two alternatives can begin with one character: then at most one of them gets past its
 * first, and what follows is reached by that one's ways alone.
 */
function disjoint(alternatives: Alternatives, flags: string): boolean {
  const seen = new Set<string>();
  for (const alternative of alternatives) {
    const first = sequenceFirst(alternative, flags);
    if (first.any || first.nullable || first.chars.some((character) => seen.has(character))) {
      return false;
    }
    for (const character of first.chars) {
      seen.add(character);
    }
  }
  return true;
}

function alternativesCost(
  alternatives: Alternatives,
  entry: number,
  after: After,
  reading: Reading,
): Cost | undefined {
  const terms: number[] = [];
  let exit = entry;
  let ways = 0;
  let most = 1;
  for (const alternative of alternatives) {
    const cost = sequenceCost(alternative, entry, after, reading);
    if (cost === undefined) {
      return undefined;
    }
    addInto(terms, cost.terms, 1);
    exit = Math.max(exit, cost.exit);
    ways += cost.factor;
    most = Math.max(most, cost.factor);
  }
  if (alternatives.length < 2) {
    return { exit, factor: Math.max(ways, 1), terms };
  }
  // Each alternative is tried in turn, a place to come back to, and what follows reached from each
  // of them — but where none begins as another can, only one gets past its first character.
  const apart = disjoint(alternatives, reading.flags);
  const tried = apart
    ? CHOICE_STEPS + ATOM_STEPS * alternatives.length
    : CHOICE_STEPS * alternatives.length;
  addInto(terms, term(entry, tried), 1);
  return { exit, factor: apart ? most : ways, terms };
}

/** Whether a quantifier takes one count only — `{2}`, `{1,1}` — and few repetitions. */
function exactly(quantifier: Counted | undefined): boolean {
  return (
    quantifier === undefined || (quantifier.min === quantifier.max && quantifier.max <= MAX_COUNTED)
  );
}

/**
 * What one repetition of a group does where it is a fixed sequence — atoms and groups taken a set
 * number of times, assertions, and lookarounds that repeat nothing, as a glob's `**` compiles into.
 * `undefined` for a group with a choice or a repetition inside, which is no fixed sequence.
 */
function iterationSteps(alternatives: Alternatives, reading: Reading): number | undefined {
  const [only, ...others] = alternatives;
  if (only === undefined || others.length > 0) {
    return undefined;
  }
  let steps = 0;
  for (const node of only) {
    const step = fixedSteps(node, reading);
    if (step === undefined) {
      return undefined;
    }
    steps += step;
  }
  return steps;
}

function fixedSteps(node: PatternNode, reading: Reading): number | undefined {
  switch (node.kind) {
    case 'anchor': {
      return ATOM_STEPS;
    }
    case 'atom': {
      if (!exactly(node.quantifier)) {
        return undefined;
      }
      return node.quantifier === undefined ? ATOM_STEPS : COUNTED_STEPS * node.quantifier.max;
    }
    case 'group': {
      const inner = exactly(node.quantifier)
        ? iterationSteps(node.alternatives, reading)
        : undefined;
      return inner === undefined ? undefined : inner * (node.quantifier?.max ?? 1);
    }
    case 'look': {
      const context: Context = { kind: node.behind ? 'lookbehind' : 'lookahead', entry: 0 };
      const cost = alternativesCost(node.alternatives, 0, contextEnd(context), reading);
      // What it tries where it stands, where nothing in it grows with the value.
      return cost === undefined || cost.terms.length > 1 ? undefined : (cost.terms[0] ?? 0);
    }
  }
}

function atomCost(
  node: Extract<PatternNode, { kind: 'atom' }>,
  entry: number,
  after: After,
  reading: Reading,
): Cost {
  const { quantifier } = node;
  if (quantifier === undefined) {
    return { exit: entry, factor: 1, terms: term(entry, ATOM_STEPS) };
  }
  if (!quantifier.repeats || quantifier.max <= MAX_COUNTED) {
    // A choice among a few counts: each repetition taken in a loop, and each count a place to come
    // back to, with what follows reached from each.
    const counts = quantifier.max - quantifier.min + 1;
    const steps = COUNTED_STEPS * quantifier.max + CHOICE_STEPS * counts;
    return { exit: entry, factor: counts, terms: term(entry, steps) };
  }
  if (endsItsContext(node, after, reading)) {
    // Reached once for each time its context is, and the context succeeds there: a scan of what it
    // takes, and what follows tried from where a greedy one stops — or, lazy, from each place it
    // stops at on the way.
    const once = after.context.entry;
    return {
      exit: quantifier.lazy ? once + 1 : once,
      factor: 1,
      terms: term(once + 1, REPEATED_STEPS),
    };
  }
  // A lookbehind is matched from its end backwards: what is tried after a repetition there is what
  // comes before it, which `after` does not say.
  const stops = after.context.kind !== 'lookbehind' && forced(node.atom, after);
  return { exit: stops ? entry : entry + 1, factor: 1, terms: term(entry + 1, REPEATED_STEPS) };
}

function groupCost(
  node: Extract<PatternNode, { kind: 'group' }>,
  entry: number,
  after: After,
  reading: Reading,
): Cost | undefined {
  const { quantifier } = node;
  if (quantifier?.repeats === true) {
    // Repeated, a group is a repetition: of a fixed sequence, which does what it does each time
    // round, or of one its delimiter splits (`delimitedRepetition`), a few steps for each character
    // of the value. Anything else inside one is refused at the upload, and not read.
    const steps = iterationSteps(node.alternatives, reading);
    if (steps !== undefined) {
      return { exit: entry + 1, factor: 1, terms: term(entry + 1, REPEATED_STEPS + steps) };
    }
    const delimited = COUNTED_STEPS + CHOICE_STEPS + ATOM_STEPS * node.fragment.length;
    return delimitedRepetition(node.fragment)
      ? { exit: entry + 1, factor: 1, terms: term(entry + 1, delimited) }
      : undefined;
  }
  const cost = alternativesCost(node.alternatives, entry, after, reading);
  if (cost === undefined || quantifier === undefined) {
    return cost;
  }
  // Optional: tried, and then skipped, with what follows reached from both.
  const terms = [...cost.terms];
  addInto(terms, term(entry, CHOICE_STEPS), 1);
  return { exit: Math.max(cost.exit, entry), factor: cost.factor + 1, terms };
}

function nodeCost(
  node: PatternNode,
  entry: number,
  after: After,
  reading: Reading,
): Cost | undefined {
  switch (node.kind) {
    case 'anchor': {
      return { exit: entry, factor: 1, terms: term(entry, ATOM_STEPS) };
    }
    case 'atom': {
      return atomCost(node, entry, after, reading);
    }
    case 'group': {
      return groupCost(node, entry, after, reading);
    }
    case 'look': {
      // Tried each time it is reached, to its own end, where it succeeds and the match goes on: its
      // ways are tried where it is, and none of them is a way for what follows to be reached by.
      const context: Context = { kind: node.behind ? 'lookbehind' : 'lookahead', entry };
      const cost = alternativesCost(node.alternatives, entry, contextEnd(context), reading);
      return cost === undefined ? undefined : { exit: entry, factor: 1, terms: cost.terms };
    }
  }
}

/**
 * A pattern's cost against a value (`PatternCost`), or `undefined` for one this does not read: a
 * backreference, a lookaround or an assertion repeated, a repeated group of any other shape than
 * `groupCost` reads, a modifier, a flag it does not read, a degree past `MAX_DEGREE`, groups nested
 * past `MAX_NESTING`, or anything longer than `MAX_ANALYZED_LENGTH`. Tried from every place in the
 * value, as `test` and `exec` try a pattern, but where each alternative begins with `^`, which only
 * the first passes.
 */
export function patternCost(
  source: string,
  flags: string,
  lineFree: boolean,
): PatternCost | undefined {
  // And `u` beside `i`, under which a letter matches others past ASCII — `k` the Kelvin sign — that
  // `caseVariants` does not name.
  const folds = flags.includes('u') && flags.includes('i');
  if (
    folds ||
    source.length > MAX_ANALYZED_LENGTH ||
    UNREAD_FLAGS.test(flags) ||
    nestingDepth(source) > MAX_NESTING
  ) {
    return undefined;
  }
  const alternatives = parseAlternatives(source, 0, source.length);
  if (alternatives === undefined) {
    return undefined;
  }
  const anchored = alternatives.every((alternative) => {
    const first = alternative[0];
    return first?.kind === 'anchor' && first.at === 'start';
  });
  const entry = anchored ? 0 : 1;
  const cost = alternativesCost(
    alternatives,
    entry,
    // Reached once whatever the place it is tried from: the match ends where it succeeds.
    contextEnd({ kind: 'pattern', entry: 0 }),
    { flags, lineFree },
  );
  if (cost === undefined) {
    return undefined;
  }
  // An attempt from each place it is tried from.
  const terms = [...cost.terms];
  addInto(terms, term(entry, CHOICE_STEPS), 1);
  if (!anchored) {
    // The places are the value's `n` characters and its end, from which an attempt is made all the
    // same: an empty value is tried once, at the only place it has. That attempt costs what one
    // costs, which is the terms one degree down — and without it, a pattern whose one attempt is
    // the expensive part read as free against an empty value: `(?:a?|b?)` twenty-four times and a
    // `!`, seconds in V8 against nothing at all. The terms are copied down before any is added to,
    // so each degree takes the one above it as it was.
    addInto(terms, terms.slice(1), 1);
  }
  return {
    degree: Math.max(
      terms.findLastIndex((steps) => steps > 0),
      0,
    ),
    terms,
  };
}

/** The steps a test of this cost takes against a value `length` long. */
function stepsAt(cost: PatternCost, length: number): number {
  return cost.terms.reduce((sum, steps, power) => sum + steps * length ** power, 0);
}

/** The longest value a test of this cost is allowed against (`BUDGET`); none where `-1`. */
export function longestAffordable(cost: PatternCost | undefined): number {
  if (cost === undefined || stepsAt(cost, 0) > BUDGET) {
    return -1;
  }
  if (cost.degree === 0) {
    return Infinity;
  }
  // The steps grow with the length: the longest within the budget, by halving.
  let low = 0;
  let high = 1;
  while (stepsAt(cost, high) <= BUDGET) {
    if (high >= MAX_VALUE_LENGTH) {
      return Infinity;
    }
    low = high;
    high *= 2;
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (stepsAt(cost, middle) <= BUDGET) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}

/** The longest values each pattern is allowed against, worked out the first time it is tested. */
interface Allowed {
  lineFree?: number;
  any?: number;
}

const allowed = new WeakMap<RegExp, Allowed>();

function allowedFor(pattern: RegExp, value: string): number {
  let lengths = allowed.get(pattern);
  if (lengths === undefined) {
    lengths = {};
    allowed.set(pattern, lengths);
  }
  const lineFree = !LINE_TERMINATOR.test(value);
  if (lineFree) {
    lengths.lineFree ??= longestAffordable(patternCost(pattern.source, pattern.flags, true));
    return lengths.lineFree;
  }
  lengths.any ??= longestAffordable(patternCost(pattern.source, pattern.flags, false));
  return lengths.any;
}

/**
 * Throw `PatternBudgetExceededError` where tests are bounded (`budgetPatterns`) and the pattern's cost
 * against `value` is past what a test is allowed; nothing otherwise.
 */
export function assertAffordable(pattern: RegExp, value: string): void {
  if (budget.on && value.length > allowedFor(pattern, value)) {
    throw new PatternBudgetExceededError({ source: pattern.source, valueLength: value.length });
  }
}

/** `pattern.test(value)`, where its cost is within what a test is allowed (`assertAffordable`). */
export function testWithin(pattern: RegExp, value: string): boolean {
  assertAffordable(pattern, value);
  return pattern.test(value);
}

/** `pattern.exec(value)`, where its cost is within what a test is allowed (`assertAffordable`). */
export function execWithin(pattern: RegExp, value: string): RegExpExecArray | null {
  assertAffordable(pattern, value);
  return pattern.exec(value);
}
