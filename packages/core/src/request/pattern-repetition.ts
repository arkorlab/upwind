import {
  type Atom,
  atomAt,
  groupContents,
  isLookaround,
  literalAt,
  type Quantifier,
  quantifierAt,
} from './pattern-syntax.ts';

/**
 * A repeated group whose repetitions a delimiter splits (`delimitedRepetition`): the one shape of
 * repetition inside repetition both the upload's check (`unsafeRoutePatternReason`) and the cost of
 * a test (`patternCost`) read as linear, because Next.js writes it for `:path*` and for the
 * redirects of `trailingSlash`.
 */

const ASCII_LETTER = /^[A-Za-z]$/u;

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
export function caseVariants(character: string): readonly string[] | undefined {
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
export function delimitedRepetition(fragment: string): boolean {
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
