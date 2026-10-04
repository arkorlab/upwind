import {
  afterCharacterClass,
  afterGroup,
  groupContents,
  literalAt,
  quantifierAt,
} from './pattern-syntax.ts';

/**
 * Whether every string a pattern matches contains a literal, read off the pattern's own characters
 * rather than by running it: a run of characters every match spells one after another, or a group
 * each alternative of which does. Read as the edge compiles a pattern, with no flags.
 *
 * Only where the reading is certain. A character with a quantifier on it, a group with one, a set,
 * a lookaround, a modifier group, and anything this does not read — a backreference, an escape
 * whose meaning turns on what follows it, a brace or bracket standing for itself — is taken to
 * spell nothing, and the run it interrupts ends there. So `false` says only that this could not
 * tell. Asked of a pattern that compiles; of one that does not, the answer means nothing.
 */

/** Escapes that stand for a set, or assert: none is a character of a run. */
const CLASS_ESCAPES: ReadonlySet<string> = new Set(['b', 'B', 'd', 'D', 's', 'S', 'w', 'W']);
/** Any character, or an anchor: not one character every match spells. */
const WILDCARD_AND_ANCHORS: ReadonlySet<string> = new Set(['$', '.', '^']);

interface Token {
  /** Just past the token and any quantifier on it. */
  readonly end: number;
  /** The one character every match spells here, for a character nothing quantifies. */
  readonly char: string | undefined;
  /** A group every match of which spells the literal. */
  readonly spells: boolean;
}

/** Where the alternatives between `start` and `end` begin and end: at each `|` of this depth. */
function alternativesBetween(
  pattern: string,
  start: number,
  end: number,
): (readonly [number, number])[] | undefined {
  const alternatives: (readonly [number, number])[] = [];
  let from = start;
  let index = start;
  while (index < end) {
    switch (pattern[index] ?? '') {
      case '\\': {
        index += 2;
        break;
      }
      case '[': {
        index = afterCharacterClass(pattern, index);
        break;
      }
      case '(': {
        index = afterGroup(pattern, index);
        break;
      }
      case ')': {
        return undefined;
      }
      case '|': {
        alternatives.push([from, index]);
        index += 1;
        from = index;
        break;
      }
      default: {
        index += 1;
      }
    }
  }
  if (index !== end) {
    return undefined;
  }
  alternatives.push([from, end]);
  return alternatives;
}

/** A single character, set, escape or anchor, and the one character it spells if it is one. */
function unitAt(pattern: string, index: number): Omit<Token, 'spells'> | undefined {
  const literal = literalAt(pattern, index);
  if (literal !== undefined) {
    return literal;
  }
  const character = pattern[index];
  if (character === '[') {
    return { end: afterCharacterClass(pattern, index), char: undefined };
  }
  if (WILDCARD_AND_ANCHORS.has(character ?? '')) {
    return { end: index + 1, char: undefined };
  }
  if (character === '\\' && CLASS_ESCAPES.has(pattern[index + 1] ?? '')) {
    return { end: index + 2, char: undefined };
  }
  return undefined;
}

function tokenAt(pattern: string, index: number, literal: string): Token | undefined {
  if (pattern[index] !== '(') {
    const unit = unitAt(pattern, index);
    if (unit === undefined) {
      return undefined;
    }
    const quantifier = quantifierAt(pattern, unit.end);
    return quantifier === undefined
      ? { ...unit, spells: false }
      : { end: quantifier.end, char: undefined, spells: false };
  }
  const close = afterGroup(pattern, index);
  if (pattern[close - 1] !== ')') {
    return undefined;
  }
  const quantifier = quantifierAt(pattern, close);
  const contents = groupContents(pattern, index);
  const spells =
    quantifier === undefined &&
    contents !== undefined &&
    everyAlternativeSpells(pattern, contents, close - 1, literal);
  return { end: quantifier?.end ?? close, char: undefined, spells };
}

function sequenceSpells(pattern: string, start: number, end: number, literal: string): boolean {
  let run = '';
  let index = start;
  while (index < end) {
    const token = tokenAt(pattern, index, literal);
    if (token === undefined || token.end > end) {
      return false;
    }
    if (token.spells) {
      return true;
    }
    if (token.char === undefined) {
      if (run.includes(literal)) {
        return true;
      }
      run = '';
    } else {
      run += token.char;
    }
    index = token.end;
  }
  return run.includes(literal);
}

function everyAlternativeSpells(
  pattern: string,
  start: number,
  end: number,
  literal: string,
): boolean {
  const alternatives = alternativesBetween(pattern, start, end);
  return alternatives?.every(([from, to]) => sequenceSpells(pattern, from, to, literal)) === true;
}

/** Whether every string `pattern` matches contains `literal`; see above for what it reads. */
export function requiresLiteral(pattern: string, literal: string): boolean {
  return literal !== '' && everyAlternativeSpells(pattern, 0, pattern.length, literal);
}
