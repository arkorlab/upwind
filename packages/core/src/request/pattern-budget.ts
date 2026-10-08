import { literalGate, longestAffordable, patternCost } from './pattern-cost.ts';

/**
 * Where a test of a routing pattern is held to what it may cost (`patternCost`): run where the value
 * is within what the pattern's cost allows, and refused where it is not, for the edge to hand the
 * request to the application's Function (`PatternBudgetExceededError`).
 */

/** The characters `.` does not take, without the `s` flag. */
const LINE_TERMINATOR = /[\n\r\u{2028}\u{2029}]/u;

/**
 * A test the edge did not run: its pattern's cost against the value is past what a test is allowed
 * (`BUDGET`, in `pattern-cost.ts`), or not one this can bound. Not a non-match: the caller hands the request to the
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

/** A pattern's literal gate (`literalGate`), and the longest values it allows a test against. */
interface Gate {
  readonly literal: string;
  readonly lineFree: number;
  any?: number;
}

/** Each pattern's gate, or `null` for one with none, worked out the first time it is needed. */
const gates = new WeakMap<RegExp, Gate | null>();

/**
 * Whether a test of `value` is within what a test is allowed for not reaching past the pattern's
 * literal gate: the value does not hold the literal, and the pattern cut after it allows a value of
 * its length (`literalGate`).
 */
function affordableShortOfLiteral(pattern: RegExp, value: string): boolean {
  let gate = gates.get(pattern);
  if (gate === undefined) {
    // Read once for the literal and for a value with no line terminator, whose cost is the one asked
    // for nearly always; the other is read the first time a value needs it.
    const read = literalGate(pattern.source, pattern.flags, true);
    gate =
      read === undefined ? null : { literal: read.literal, lineFree: longestAffordable(read.cost) };
    gates.set(pattern, gate);
  }
  if (gate === null) {
    return false;
  }
  const held = pattern.flags.includes('i') ? value.toLowerCase() : value;
  if (held.includes(gate.literal)) {
    return false;
  }
  const lineFree = !LINE_TERMINATOR.test(value);
  if (lineFree) {
    return value.length <= gate.lineFree;
  }
  gate.any ??= longestAffordable(literalGate(pattern.source, pattern.flags, false)?.cost);
  return value.length <= gate.any;
}

/**
 * Throw `PatternBudgetExceededError` where tests are bounded (`budgetPatterns`) and the pattern's cost
 * against `value` is past what a test is allowed — the whole pattern's, or, for a value that does not
 * hold its literal gate, what comes before the gate (`literalGate`); nothing otherwise.
 */
export function assertAffordable(pattern: RegExp, value: string): void {
  if (
    budget.on &&
    value.length > allowedFor(pattern, value) &&
    !affordableShortOfLiteral(pattern, value)
  ) {
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
