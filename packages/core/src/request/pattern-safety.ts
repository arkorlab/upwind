import { sourceRegexSchema } from '../util/regex-source.ts';
import {
  afterCharacterClass,
  afterGroup,
  type Atom,
  atomAt,
  groupContents,
  isLookaround,
  literalAt,
  type Quantifier,
  quantifierAt,
} from './pattern-syntax.ts';

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
 * not claim every pattern it admits is linear.
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
const ASCII_LETTER = /^[A-Za-z]$/u;

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

interface DelimitedStep {
  readonly next: number;
  readonly quantified: boolean;
}

/**
 * What an expression run with `i` takes a delimiter to be, or `undefined` where that is not told
 * simply. Patterns are run so — a middleware matcher at the edge, a routing rule while a deployment
 * is planned — and there `A+` consumes the `a` that was to divide `(?:aA+)+`. A character no case
 * applies to is only itself, an ASCII letter is itself and its other case, and any other cased
 * character is left out of the shape rather than reasoned about.
 */
function caseVariants(character: string): readonly string[] | undefined {
  const lower = character.toLowerCase();
  const upper = character.toUpperCase();
  if (lower === character && upper === character) {
    return [character];
  }
  return ASCII_LETTER.test(character) ? [lower, upper] : undefined;
}

/** One unit of a delimited repetition's contents, or `undefined` for one that breaks the shape. */
function delimitedStep(
  fragment: string,
  index: number,
  delimiter: readonly string[],
): DelimitedStep | undefined {
  const character = fragment[index];
  if (character === '(') {
    const inner = isLookaround(fragment, index) ? undefined : groupContents(fragment, index);
    return inner === undefined ? undefined : { next: inner, quantified: false };
  }
  if (character === ')') {
    // A group inside that is itself quantified is a second level of repetition.
    return quantifierAt(fragment, index + 1) === undefined
      ? { next: index + 1, quantified: false }
      : undefined;
  }
  const atom = atomAt(fragment, index);
  if (atom === undefined) {
    return undefined;
  }
  const quantifier = quantifierAt(fragment, atom.end);
  if (quantifier === undefined) {
    return { next: atom.end, quantified: false };
  }
  return delimiter.some((variant) => atom.matches(variant))
    ? undefined
    : { next: quantifier.end, quantified: true };
}

/**
 * Whether a repeated group is split by a delimiter that nothing quantified in it can consume, which
 * makes it linear however the group is quantified.
 *
 * `(?:\/(?:[^\/]+?))*` — what Next.js compiles `:path*` into — must begin every repetition with a
 * `/`, and its one quantified part cannot consume one. Where each repetition begins is therefore
 * fixed by where the input's slashes are: there is one way to divide the input into repetitions,
 * and each part's length is tried once. What multiplies backtracking is a choice between two ways
 * of dividing it, so the group may hold at most one quantified part, no alternatives, and no part
 * that could itself consume the delimiter.
 *
 * `(?:[^/]+\/)*` — what Next.js compiles the redirects of `trailingSlash: true` into — is the same
 * with the delimiter last: every repetition ends at a `/` its quantified part cannot consume, so
 * the slashes fix where each one ends as they fix where one begins above. Read only as plain units,
 * with no group inside, which is all Next.js writes there.
 */
function delimitedRepetition(fragment: string): boolean {
  const contents = groupContents(fragment, 0);
  return (
    contents !== undefined &&
    (leadingDelimited(fragment, contents) || trailingDelimited(fragment, contents))
  );
}

function leadingDelimited(fragment: string, contents: number): boolean {
  const delimiter = literalAt(fragment, contents);
  const variants = delimiter === undefined ? undefined : caseVariants(delimiter.char);
  if (
    delimiter === undefined ||
    variants === undefined ||
    quantifierAt(fragment, delimiter.end) !== undefined
  ) {
    return false;
  }
  let quantified = 0;
  let index = delimiter.end;
  while (index < fragment.length) {
    const step = delimitedStep(fragment, index, variants);
    if (step === undefined) {
      return false;
    }
    quantified += step.quantified ? 1 : 0;
    if (quantified > 1) {
      return false;
    }
    index = step.next;
  }
  return true;
}

function trailingDelimited(fragment: string, contents: number): boolean {
  const units: { start: number; atom: Atom; quantifier: Quantifier | undefined }[] = [];
  let index = contents;
  while (index < fragment.length) {
    const atom = atomAt(fragment, index);
    if (atom === undefined) {
      return false;
    }
    const quantifier = quantifierAt(fragment, atom.end);
    units.push({ start: index, atom, quantifier });
    index = quantifier?.end ?? atom.end;
  }
  const last = units.at(-1);
  const delimiter = last === undefined ? undefined : literalAt(fragment, last.start);
  const variants = delimiter === undefined ? undefined : caseVariants(delimiter.char);
  // The delimiter is the group's last unit, and it is not quantified itself.
  if (variants === undefined || last?.quantifier !== undefined) {
    return false;
  }
  // Before it, as Next.js writes it: one part that repeats and cannot consume the delimiter, and
  // nothing else quantified. What is optional there is refused, as it is anywhere in a repetition.
  const quantified = units.slice(0, -1).filter((unit) => unit.quantifier !== undefined);
  const [part] = quantified;
  return (
    quantified.length === 1 &&
    part?.quantifier?.repeats === true &&
    variants.every((variant) => !part.atom.matches(variant))
  );
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
  return scanReason(expression);
}

/**
 * The same judgement for an expression the edge compiles as it is: a route's source, a middleware
 * matcher, an image pattern. One that does not compile is left to the check that says so.
 */
export function unsafeSourcePatternReason(source: string): string | undefined {
  if (source.length > MAX_SOURCE_LENGTH) {
    return `longer than ${MAX_SOURCE_LENGTH} characters`;
  }
  return compiles(source) ? scanReason(source) : undefined;
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
