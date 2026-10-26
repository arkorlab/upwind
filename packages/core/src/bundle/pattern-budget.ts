import {
  BUDGET,
  literalGate,
  patternCost,
  type PatternCost,
  stepsAt,
} from '../request/pattern-cost.ts';

/** Independent of request routing: no assembly enables the edge's isolate-wide switch. */
const MATCHES_PER_BUILD = 1024;
export const BUILD_PATTERN_BUDGET = BUDGET * MATCHES_PER_BUILD;
const LINE_TERMINATOR = /[\n\r\u{2028}\u{2029}]/u;

export class BuildPatternBudgetExceededError extends Error {
  constructor() {
    super('the build exceeds the routing pattern execution budget');
    this.name = 'BuildPatternBudgetExceededError';
  }
}

interface Compiled {
  readonly pattern: RegExp;
  lineFree?: PatternCost | null;
  any?: PatternCost | null;
  gate?: ReturnType<typeof literalGate> | null;
  anyGate?: ReturnType<typeof literalGate> | null;
}

/** A single build operation's allowance, passed explicitly through its assembly helpers. */
export class BuildPatternBudget {
  private remaining: number;
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

  private admitted(source: string, flags: '' | 'i', value: string): RegExp {
    let allowance = Math.min(BUDGET, this.remaining);
    const spend = (steps: number): void => {
      if (!Number.isFinite(steps) || steps > allowance) {
        throw new BuildPatternBudgetExceededError();
      }
      this.spend(steps);
      allowance -= steps;
    };
    const key = `${flags}\0${source}`;
    let compiled = this.compiled.get(key);
    if (compiled === undefined) {
      spend(Math.max(1, source.length));
      // The same legacy grammar and flags as the router's original expression.
      // eslint-disable-next-line security/detect-non-literal-regexp
      compiled = { pattern: new RegExp(source, flags) };
      this.compiled.set(key, compiled);
    }
    spend(Math.max(1, value.length));
    const lineFree = !LINE_TERMINATOR.test(value);
    const field = lineFree ? 'lineFree' : 'any';
    if (compiled[field] === undefined) {
      spend(Math.max(1, source.length));
      compiled[field] = patternCost(source, flags, lineFree) ?? null;
    }
    const cost = compiled[field];
    let steps = cost === null ? Infinity : stepsAt(cost, value.length);
    if (steps > allowance) {
      steps = this.shortOfLiteral(compiled, value, lineFree, spend);
    }
    spend(Math.max(1, steps));
    return compiled.pattern;
  }

  private shortOfLiteral(
    compiled: Compiled,
    value: string,
    lineFree: boolean,
    spend: (steps: number) => void,
  ): number {
    const { source } = compiled.pattern;
    const flags = compiled.pattern.ignoreCase ? 'i' : '';
    const field = lineFree ? 'gate' : 'anyGate';
    if (compiled[field] === undefined) {
      spend(Math.max(1, source.length));
      compiled[field] = literalGate(source, flags, lineFree) ?? null;
    }
    const gate = compiled[field];
    if (gate?.cost === undefined) return Infinity;
    spend(Math.max(1, value.length) * (flags === 'i' ? 2 : 1));
    const held = flags === 'i' ? value.toLowerCase() : value;
    return held.includes(gate.literal) ? Infinity : stepsAt(gate.cost, value.length);
  }

  test(source: string, flags: '' | 'i', value: string): boolean {
    return this.admitted(source, flags, value).test(value);
  }

  exec(source: string, flags: '' | 'i', value: string): RegExpExecArray | null {
    return this.admitted(source, flags, value).exec(value);
  }
}

/** Internal compatibility path for helpers also used by an application's own Function. */
export interface BuildPatternMatcher {
  test(source: string, flags: '' | 'i', value: string): boolean;
  exec(source: string, flags: '' | 'i', value: string): RegExpExecArray | null;
}

export const nativeBuildPatterns: BuildPatternMatcher = {
  // eslint-disable-next-line security/detect-non-literal-regexp
  test: (source, flags, value) => new RegExp(source, flags).test(value),
  // eslint-disable-next-line security/detect-non-literal-regexp
  exec: (source, flags, value) => new RegExp(source, flags).exec(value),
};
