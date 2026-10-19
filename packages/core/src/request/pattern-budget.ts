import { BUDGET, literalGate, patternCost, type PatternCost, stepsAt } from './pattern-cost.ts';
import { createShortPatternCheck } from './required-literal-length.ts';

/**
 * Where a test of a routing pattern is held to what it may cost (`patternCost`): run where the value
 * is within what the pattern's cost allows, and refused where it is not, for the edge to hand the
 * request to the application's Function (`PatternBudgetExceededError`).
 */

/** The characters `.` does not take, without the `s` flag. */
const LINE_TERMINATOR = /[\n\r\u{2028}\u{2029}]/u;

/**
 * A test the edge did not run: its pattern's cost against the value is past what a test is allowed
 * (`BUDGET`, in `pattern-cost.ts`), exceeds what this request has left, or is not one this can bound.
 * Not a non-match: the caller hands the request to the application's Function, which routes it itself.
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

/** The steps one request has left for all of its routing pattern tests together. */
export interface PatternBudget {
  remaining: number;
}

/** A new request's allowance; creating one does not enable bounds in an application's Function. */
export function createPatternBudget(): PatternBudget {
  return { remaining: BUDGET };
}

const budget: {
  on: boolean;
  current?: () => PatternBudget | undefined;
  tooShort?: (pattern: RegExp, value: string) => boolean;
} = { on: false };

/** Each pattern's cost, read once for each kind of value; `null` where it cannot be bounded. */
interface Costs {
  lineFree?: PatternCost | null;
  any?: PatternCost | null;
}

const costs = new WeakMap<RegExp, Costs>();

/**
 * Bound every test of a routing pattern from here on (`testWithin`, `execWithin`): what the edge
 * asks for before it routes a request.
 *
 * Off until a host asks, because only a host that runs the patterns of applications it does not own
 * — against values their visitors chose, on a Function they all share — has a reason to. A server of
 * one application, its own Function among them, tests that application's patterns as Next.js does,
 * with nothing to hand a request it would not test to.
 *
 * Asked once per isolate, and for good: an isolate that asks is one that routes for an edge and
 * nothing else. A host can supply the getter of its request-local store (`current`), so all tests
 * made for one request share its allowance (`createPatternBudget`) even across asynchronous work.
 * The host owns that store; core depends on no particular runtime's asynchronous context API. A
 * later call with no getter leaves the installed one in place. Outside a store, only each test is
 * bounded, as before. Where either bound is exceeded, every function here throws
 * (`PatternBudgetExceededError`) for its caller to hand the request to the application's Function.
 */
export function budgetPatterns(current?: () => PatternBudget | undefined): void {
  budget.on = true;
  if (current !== undefined) {
    budget.current = current;
  }
  budget.tooShort ??= createShortPatternCheck(budget, costs);
}

function costFor(pattern: RegExp, lineFree: boolean): PatternCost | null {
  let known = costs.get(pattern);
  if (known === undefined) {
    known = {};
    costs.set(pattern, known);
  }
  if (lineFree) {
    if (known.lineFree === undefined) {
      known.lineFree = patternCost(pattern.source, pattern.flags, true) ?? null;
    }
    return known.lineFree;
  }
  if (known.any === undefined) {
    known.any = patternCost(pattern.source, pattern.flags, false) ?? null;
  }
  return known.any;
}

/** A pattern's literal gate (`literalGate`), and what a test that cannot reach it costs. */
interface Gate {
  readonly literal: string;
  readonly lineFree: PatternCost | null;
  any?: PatternCost | null;
}

/** Each pattern's gate, or `null` for one with none, worked out the first time it is needed. */
const gates = new WeakMap<RegExp, Gate | null>();

/**
 * What a test of `value` costs if it cannot pass the pattern's literal gate (`literalGate`). The
 * scans are reserved and charged before they run, even if the value holds the literal or the
 * regex cannot be afforded afterwards. Without a request store their cost is included in the
 * returned bound instead. `Infinity` where the value holds the literal or the cost is unbounded.
 */
function stepsShortOfLiteral(
  pattern: RegExp,
  value: string,
  lineFree: boolean,
  current: PatternBudget | undefined,
): number {
  let gate = gates.get(pattern);
  if (gate === undefined) {
    // Read once for the literal and for a value with no line terminator, whose cost is the one asked
    // for nearly always; the other is read the first time a value needs it.
    const read = literalGate(pattern.source, pattern.flags, true);
    gate = read === undefined ? null : { literal: read.literal, lineFree: read.cost ?? null };
    gates.set(pattern, gate);
  }
  if (gate === null) {
    return Infinity;
  }
  const ignoresCase = pattern.flags.includes('i');
  // Finding the missing literal, and folding the value where needed, are linear work too. A caller
  // may catch a refusal and try another candidate; scans already done must still spend its budget.
  const scan = value.length * (ignoresCase ? 2 : 1);
  if (scan + 1 > (current?.remaining ?? BUDGET - Math.max(1, value.length))) {
    return Infinity;
  }
  if (current !== undefined) {
    current.remaining -= scan;
  }
  const held = ignoresCase ? value.toLowerCase() : value;
  if (held.includes(gate.literal)) {
    return Infinity;
  }
  const unscopedScan = current === undefined ? scan : 0;
  if (lineFree) {
    return gate.lineFree === null ? Infinity : unscopedScan + stepsAt(gate.lineFree, value.length);
  }
  if (gate.any === undefined) {
    gate.any = literalGate(pattern.source, pattern.flags, false)?.cost ?? null;
  }
  return gate.any === null ? Infinity : unscopedScan + stepsAt(gate.any, value.length);
}

/**
 * Throw `PatternBudgetExceededError` where tests are bounded (`budgetPatterns`) and the pattern's cost
 * against `value` is past what a test or the current request has left — the whole pattern's, or,
 * for a value that does not hold its literal gate, what comes before the gate (`literalGate`). A
 * regex that fits is charged to the current request before it runs. Guard scans are charged before
 * they run even where the regex is later refused; without a store only that test is bounded.
 * Ordinary affordable tests never need to read or search for their literal gate.
 */
export function assertAffordable(pattern: RegExp, value: string): void {
  if (!budget.on) {
    return;
  }
  const current = budget.current?.();
  const remaining = current?.remaining ?? BUDGET;
  // Even an anchored, constant-cost non-match scans the value here to decide what `.` can take.
  // Reserve that work once, before doing it; even an empty value takes one guard attempt, and the
  // regex itself costs at least one more.
  const guard = Math.max(1, value.length);
  const available = remaining - guard;
  if (available < 1) {
    throw new PatternBudgetExceededError({ source: pattern.source, valueLength: value.length });
  }
  if (current !== undefined) {
    current.remaining -= guard;
  }
  const lineFree = !LINE_TERMINATOR.test(value);
  const cost = costFor(pattern, lineFree);
  let steps = cost === null ? Infinity : stepsAt(cost, value.length);
  if (steps > available) {
    steps = stepsShortOfLiteral(pattern, value, lineFree, current);
  }
  // Even a zero-length value requires the engine to attempt the pattern once.
  steps = Math.max(1, steps);
  if (steps > (current?.remaining ?? available)) {
    throw new PatternBudgetExceededError({ source: pattern.source, valueLength: value.length });
  }
  if (current !== undefined) {
    current.remaining -= steps;
  }
}

/** `pattern.test(value)`, where its cost is within what a test is allowed (`assertAffordable`). */
export function testWithin(pattern: RegExp, value: string): boolean {
  if (budget.tooShort?.(pattern, value) === true) return false;
  assertAffordable(pattern, value);
  return pattern.test(value);
}

/** `pattern.exec(value)`, where its cost is within what a test is allowed (`assertAffordable`). */
export function execWithin(pattern: RegExp, value: string): RegExpExecArray | null {
  if (budget.tooShort?.(pattern, value) === true) return null;
  assertAffordable(pattern, value);
  return pattern.exec(value);
}
