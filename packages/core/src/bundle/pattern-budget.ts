import { payloadHeadOf, payloadHeadsOf } from '../paas/payload-matcher.ts';
import {
  BUDGET,
  literalGate,
  MAX_NESTING,
  patternCost,
  type PatternCost,
  stepsAt,
} from '../request/pattern-cost.ts';
import { nestingDepth } from '../request/pattern-tree.ts';
import { localeMiddlewareSource } from './middleware-locale.ts';

/** Independent of request routing: no assembly enables the edge's isolate-wide switch. */
const MATCHES_PER_BUILD = 1024;
export const BUILD_PATTERN_BUDGET = BUDGET * MATCHES_PER_BUILD;
const SPLIT_WORK_PER_UNIT = 16;
const MAX_CACHED_TESTS = 4096;
const MAX_CACHED_UNITS = 131_072;
const LINE_TERMINATOR = /[\n\r\u{2028}\u{2029}]/u;

export class BuildPatternBudgetExceededError extends Error {
  constructor() {
    super('the build exceeds the routing pattern execution budget');
    this.name = 'BuildPatternBudgetExceededError';
  }
}

interface Spend {
  readonly remaining: () => number;
  readonly take: (steps: number) => void;
}

interface Compiled {
  readonly pattern: RegExp;
  tests?: Map<string, boolean>;
  lineFree?: PatternCost | null;
  any?: PatternCost | null;
  gate?: ReturnType<typeof literalGate> | null;
  anyGate?: ReturnType<typeof literalGate> | null;
}

/** A single build operation's allowance, passed explicitly through its assembly helpers. */
export class BuildPatternBudget {
  private remaining: number;
  private cachedTests = 0;
  private cachedUnits = 0;
  private readonly compiled = new Map<string, Compiled>();

  constructor(allowance = BUILD_PATTERN_BUDGET) {
    if (!Number.isFinite(allowance) || allowance < 1 || allowance > BUILD_PATTERN_BUDGET) {
      throw new RangeError('a build pattern allowance must be positive and within the build limit');
    }
    this.remaining = allowance;
  }

  private spend(steps: number): void {
    if (!Number.isFinite(steps) || steps > this.remaining) {
      throw new BuildPatternBudgetExceededError();
    }
    this.remaining -= steps;
  }

  private allowance(): Spend {
    let allowance = Math.min(BUDGET, this.remaining);
    return {
      remaining: () => allowance,
      take: (steps) => {
        if (!Number.isFinite(steps) || steps > allowance)
          throw new BuildPatternBudgetExceededError();
        this.spend(steps);
        allowance -= steps;
      },
    };
  }

  private compiledFor(source: string, flags: '' | 'i', spend: Spend): Compiled {
    // Account for source hashing and concatenation on cache hits as well as compilation misses.
    spend.take(Math.max(1, source.length));
    const key = `${flags}\0${source}`;
    let compiled = this.compiled.get(key);
    if (compiled === undefined) {
      // eslint-disable-next-line security/detect-non-literal-regexp -- same legacy grammar as Next.
      compiled = { pattern: new RegExp(source, flags) };
      this.compiled.set(key, compiled);
    }
    return compiled;
  }

  private admitted(compiled: Compiled, value: string, spend: Spend): RegExp {
    const { source } = compiled.pattern;
    const flags = compiled.pattern.ignoreCase ? 'i' : '';
    spend.take(Math.max(1, value.length));
    const lineFree = !LINE_TERMINATOR.test(value);
    const field = lineFree ? 'lineFree' : 'any';
    if (compiled[field] === undefined) {
      spend.take(Math.max(1, source.length));
      compiled[field] = patternCost(source, flags, lineFree) ?? null;
    }
    const cost = compiled[field];
    let steps = cost === null ? Infinity : stepsAt(cost, value.length);
    // A cheap miss still matters across thousands of build paths. Read its smaller bound where
    // scanning for a required literal can cost less than testing the whole pattern; keeping the
    // whole bound for every miss can exhaust the operation even when no individual match would.
    const scan = Math.max(1, value.length) * (flags === 'i' ? 2 : 1);
    if (steps > Math.min(spend.remaining(), scan)) {
      steps = Math.min(
        steps,
        this.shortOfLiteral(compiled, value, spend, { lineFree, fullSteps: steps }),
      );
    }
    spend.take(Math.max(1, steps));
    return compiled.pattern;
  }

  private shortOfLiteral(
    compiled: Compiled,
    value: string,
    spend: Spend,
    bound: { readonly lineFree: boolean; readonly fullSteps: number },
  ): number {
    const { lineFree, fullSteps } = bound;
    const { source } = compiled.pattern;
    const flags = compiled.pattern.ignoreCase ? 'i' : '';
    const field = lineFree ? 'gate' : 'anyGate';
    if (compiled[field] === undefined) {
      spend.take(Math.max(1, source.length));
      compiled[field] = literalGate(source, flags, lineFree) ?? null;
    }
    const gate = compiled[field];
    if (gate?.cost === undefined) return Infinity;
    const steps = stepsAt(gate.cost, value.length);
    const scan = Math.max(1, value.length) * (flags === 'i' ? 2 : 1);
    // Finding a missing literal is useful only where its scan and smaller bound save work.
    if (scan + steps >= fullSteps) return Infinity;
    spend.take(scan);
    const held = flags === 'i' ? value.toLowerCase() : value;
    return held.includes(gate.literal) ? Infinity : steps;
  }

  private payloadHead(pattern: RegExp, spend: Spend): RegExp | null {
    spend.take(Math.max(1, pattern.source.length));
    if (nestingDepth(pattern.source) > MAX_NESTING) throw new BuildPatternBudgetExceededError();
    return payloadHeadOf(pattern);
  }

  private splitHead(
    compiled: Compiled,
    value: string,
    spend: Spend,
  ): { head: RegExp | null; impossible: boolean } {
    const head = this.payloadHead(compiled.pattern, spend);
    if (head !== null) return { head, impossible: false };
    const flags = compiled.pattern.ignoreCase ? 'i' : '';
    spend.take(Math.max(1, value.length) * SPLIT_WORK_PER_UNIT);
    const locale = localeMiddlewareSource(compiled.pattern, value, (prefix) =>
      this.admitted(this.compiledFor(prefix, flags, spend), value, spend).test(value),
    );
    if (locale.kind === 'unsupported') return { head: null, impossible: false };
    const proved = this.payloadHead(this.compiledFor(locale.source, flags, spend).pattern, spend);
    return { head: proved, impossible: proved !== null && locale.kind === 'mismatch' };
  }

  private splitMatches(compiled: Compiled, value: string, spend: Spend): boolean {
    const { head, impossible } = this.splitHead(compiled, value, spend);
    if (impossible) return false;
    if (head === null) throw new BuildPatternBudgetExceededError();
    const flags = compiled.pattern.ignoreCase ? 'i' : '';
    spend.take(Math.max(1, value.length) * SPLIT_WORK_PER_UNIT);
    const split = payloadHeadsOf(value, compiled.pattern.ignoreCase);
    if (split === undefined) throw new BuildPatternBudgetExceededError();
    const bounded = this.compiledFor(head.source, flags, spend);
    let refused: BuildPatternBudgetExceededError | undefined;
    for (const candidate of split) {
      try {
        if (this.admitted(bounded, candidate, spend).test(candidate)) return true;
      } catch (error) {
        if (!(error instanceof BuildPatternBudgetExceededError)) throw error;
        refused ??= error;
      }
    }
    if (refused !== undefined) throw refused;
    return false;
  }

  test(source: string, flags: '' | 'i', value: string): boolean {
    const spend = this.allowance();
    const compiled = this.compiledFor(source, flags, spend);
    // Hashing/looking up an input is still work, even when a previous phase already matched it.
    spend.take(Math.max(1, value.length));
    const previous = compiled.tests?.get(value);
    if (previous !== undefined) return previous;
    let matched: boolean;
    try {
      matched = this.admitted(compiled, value, spend).test(value);
    } catch (error) {
      if (!(error instanceof BuildPatternBudgetExceededError)) throw error;
      matched = this.splitMatches(compiled, value, spend);
    }
    const units = Math.max(1, value.length);
    if (this.cachedTests < MAX_CACHED_TESTS && this.cachedUnits + units <= MAX_CACHED_UNITS) {
      compiled.tests ??= new Map();
      compiled.tests.set(value, matched);
      this.cachedTests += 1;
      this.cachedUnits += units;
    }
    return matched;
  }

  exec(source: string, flags: '' | 'i', value: string): RegExpExecArray | null {
    const spend = this.allowance();
    return this.admitted(this.compiledFor(source, flags, spend), value, spend).exec(value);
  }
}
