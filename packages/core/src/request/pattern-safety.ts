import { sourceRegexSchema } from '../util/regex-source.ts';
import { longestAffordable, patternCost } from './pattern-cost.ts';
import { delimitedRepetition } from './pattern-repetition.ts';
import { afterCharacterClass, afterGroup, isLookaround, quantifierAt } from './pattern-syntax.ts';

/**
 * Whether a routing pattern is one the edge may run against a value a visitor chose.
 *
 * A hosted project's `has` / `missing` conditions carry patterns straight from its `next.config`,
 * and its routes carry the expressions Next.js compiled their sources into; the edge tests them
 * against headers, cookies, query values and pathnames on a Function shared with every other
 * project. V8's regexp engine backtracks and cannot be interrupted, so a pattern with a quantifier
 * or overlapping alternatives inside a repeated group — `(a+)+`, `(a|aa)+` — can turn a long
 * crafted value into seconds of CPU before the request has even been dispatched.
 *
 * Checked where the bundle is uploaded, never per request: a deployment that names such a pattern
 * is refused with the pattern in the message, and the edge goes on doing exactly what it did.
 *
 * This is a shape check, not a decision procedure. It refuses repetition, alternatives and optional
 * expressions inside repeated groups, without trying to prove whether their choices overlap. That
 * also refuses safe forms such as `(ja|en)+` and `(a?b)+`; ordinary `(ja|en)` conditions and
 * `(?<slug>[^/]+?)` templates remain usable. Two shapes are recognised as safe because Next.js
 * writes them: a repetition split by a delimiter nothing else in it can consume — what `:path*`
 * compiles into, the delimiter first, and what the redirects of `trailingSlash` compile into, the
 * delimiter last — and a lookaround inside a repetition, as a glob's `**` compiles into. It does
 * not claim every pattern it admits is linear: what it admits, the edge tests only against values
 * short enough for the pattern's cost (`patternCost`), and refused here is a pattern whose cost it
 * cannot bound against any value.
 */

/** Longer than any condition Next.js emits, and past what this check can usefully reason about. */
const MAX_PATTERN_LENGTH = 1000;
/**
 * Longer than any route source a build of this repository's apps compiles (the longest is about
 * 250 characters), with room for a long list of locales, and still short enough to read in full.
 */
const MAX_SOURCE_LENGTH = 4096;

interface Scan {
  /** Where each still-open group started, so its contents can be judged when it closes. */
  readonly open: number[];
  reason: string | undefined;
}

function scanCharacter(pattern: string, index: number, scan: Scan): number {
  const character = pattern[index];
  if (character === '\\') {
    // An escape takes the next character with it, whatever that character means unescaped.
    return index + 2;
  }
  if (character === '[') {
    // A class is a single unit: nothing inside it quantifies anything else.
    return afterCharacterClass(pattern, index);
  }
  if (character === '(') {
    scan.open.push(index);
    return index + 1;
  }
  if (character === ')') {
    const start = scan.open.pop();
    if (start !== undefined && quantifierAt(pattern, index + 1)?.repeats === true) {
      scan.reason ??= repeatedGroupReason(pattern.slice(start, index));
    }
    return index + 1;
  }
  return index + 1;
}

/** Repetition can revisit both inner repetitions and alternative ways to partition the input. */
function repeatedGroupReason(fragment: string): string | undefined {
  const reason = shapeReason(fragment);
  return reason === undefined || delimitedRepetition(fragment) ? undefined : reason;
}

const QUANTIFIED = 'a quantifier inside a quantified group can backtrack catastrophically';
const ALTERNATED = 'alternation inside a repeated group can backtrack catastrophically';
const OPTIONAL = 'an optional expression inside a repeated group can backtrack catastrophically';

/**
 * Where the scan goes on from, past a unit that says nothing about repetition — an escape, a set,
 * a lookaround, a group's introducer — or `undefined` for a character that may.
 */
function skippedTo(fragment: string, index: number): number | undefined {
  const character = fragment[index];
  if (character === '\\') {
    return index + 2;
  }
  if (character === '[') {
    return afterCharacterClass(fragment, index);
  }
  if (character !== '(') {
    return undefined;
  }
  // What a lookaround tests is not repeated with the group: it consumes nothing, and the engine
  // never backtracks into it. A repetition inside one is judged when its own group closes.
  if (index > 0 && isLookaround(fragment, index)) {
    return afterGroup(fragment, index);
  }
  // Consume the group introducer here: a question mark after an escaped opening parenthesis
  // still quantifies that literal. Quantifier tokens consume their own lazy suffix below.
  return fragment[index + 1] === '?' ? index + 2 : undefined;
}

function shapeReason(fragment: string): string | undefined {
  let index = 0;
  let alternatives = false;
  let optional = false;
  while (index < fragment.length) {
    const skipped = skippedTo(fragment, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const quantifier = quantifierAt(fragment, index);
    if (quantifier?.repeats === true) {
      return QUANTIFIED;
    }
    optional ||= quantifier?.optional === true;
    alternatives ||= fragment[index] === '|';
    index = quantifier?.end ?? index + 1;
  }
  if (alternatives) {
    return ALTERNATED;
  }
  return optional ? OPTIONAL : undefined;
}

function compiles(pattern: string): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
    return new RegExp(pattern) instanceof RegExp;
  } catch {
    return false;
  }
}

function scanReason(expression: string): string | undefined {
  const scan: Scan = { open: [], reason: undefined };
  let index = 0;
  while (index < expression.length && scan.reason === undefined) {
    index = scanCharacter(expression, index, scan);
  }
  return scan.reason;
}

/**
 * Why the edge could test a pattern against no value at all: a shape whose cost `patternCost` does
 * not read — a backreference, a modifier, a lookaround repeated — or one that costs more than a test
 * is allowed whatever the value (`longestAffordable`) — under any of the flags it runs with. Admitted,
 * every request it is asked of would go to the application's Function, a shipped file among them,
 * which the Function does not carry.
 */
function unboundedReason(expression: string, flags: readonly string[] = ['']): string | undefined {
  const unbounded = flags.some(
    (flag) => longestAffordable(patternCost(expression, flag, false)) < 0,
  );
  return unbounded
    ? 'its cost against a value cannot be bounded within what a test is allowed'
    : undefined;
}

/**
 * The flags a source is run with: as it is for a dynamic route or an image, and without regard to
 * case for a middleware's matcher, a rule ahead of the routes and a header rule (`compiledRules`),
 * under which alternatives one spelling tells apart may not be.
 */
const SOURCE_FLAGS = ['', 'i'];

/** `undefined` when the pattern may be run; otherwise why it may not. */
export function unsafeRoutePatternReason(pattern: string): string | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `longer than ${MAX_PATTERN_LENGTH} characters`;
  }
  // Conditions are anchored with this wrapper by conditionMatches. An unbalanced value can
  // become a valid expression inside it, so inspect exactly what the edge will compile and run.
  const expression = `^(?:${pattern})$`;
  if (!compiles(expression)) {
    // Not a pattern at all: the edge falls back to comparing it as a literal, which is safe.
    return undefined;
  }
  // And as it is, which the edge tries anywhere in the value where the whole of it does not match.
  return (
    scanReason(expression) ??
    unboundedReason(expression) ??
    (compiles(pattern) ? unboundedReason(pattern) : undefined)
  );
}

/**
 * The same judgement for an expression the edge compiles as it is: a route's source, a middleware
 * matcher, an image pattern. One that does not compile is left to the check that says so.
 */
export function unsafeSourcePatternReason(source: string): string | undefined {
  if (source.length > MAX_SOURCE_LENGTH) {
    return `longer than ${MAX_SOURCE_LENGTH} characters`;
  }
  return compiles(source)
    ? (scanReason(source) ?? unboundedReason(source, SOURCE_FLAGS))
    : undefined;
}

/**
 * An expression as an upload carries it: one that compiles, and one the edge may run against a
 * pathname or a hostname a visitor chose.
 */
export const runnableSourceRegexSchema = sourceRegexSchema.superRefine((source, ctx) => {
  const reason = unsafeSourcePatternReason(source);
  if (reason !== undefined) {
    ctx.addIssue({ code: 'custom', message: `unusable pattern: ${reason}` });
  }
});
