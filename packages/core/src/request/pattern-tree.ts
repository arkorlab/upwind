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
 * A routing pattern read as a tree, as the cost of running it is read (`patternCost`): alternatives
 * of sequences, each node an atom with its quantifier, a group with its own alternatives, a
 * lookaround, or an assertion. What it does not read — a backreference, a modifier, an assertion or
 * a lookaround repeated, a group that does not close — it reports as nothing at all, and the
 * pattern is not run where a test is bounded.
 */

/** A quantifier with the fewest and the most repetitions it takes, and whether it is lazy. */
export interface Counted extends Quantifier {
  readonly min: number;
  readonly max: number;
  readonly lazy: boolean;
}

export type Alternatives = readonly (readonly PatternNode[])[];

export type PatternNode =
  | {
      readonly kind: 'atom';
      readonly atom: Atom;
      readonly dot: boolean;
      readonly literal: string | undefined;
      readonly quantifier: Counted | undefined;
    }
  | {
      readonly kind: 'group';
      readonly alternatives: Alternatives;
      readonly quantifier: Counted | undefined;
      /** From its `(` to before its `)`, as `delimitedRepetition` reads a group. */
      readonly fragment: string;
    }
  | { readonly kind: 'look'; readonly alternatives: Alternatives; readonly behind: boolean }
  | { readonly kind: 'anchor'; readonly at: 'start' | 'end' | 'boundary' };

interface Parsed {
  readonly node: PatternNode;
  readonly end: number;
}

/**
 * The fewest and the most repetitions the quantifier at `index` takes. A counted one is read as
 * `quantifierAt` has checked it: digits, then a comma and digits or nothing, in braces.
 */
function countsAt(pattern: string, index: number): { readonly min: number; readonly max: number } {
  const character = pattern[index];
  if (character !== '{') {
    return { min: character === '+' ? 1 : 0, max: character === '?' ? 1 : Infinity };
  }
  const body = pattern.slice(index + 1, pattern.indexOf('}', index));
  const comma = body.indexOf(',');
  if (comma === -1) {
    return { min: Number(body), max: Number(body) };
  }
  const high = body.slice(comma + 1);
  return { min: Number(body.slice(0, comma)), max: high === '' ? Infinity : Number(high) };
}

function countedAt(pattern: string, index: number): Counted | undefined {
  const quantifier = quantifierAt(pattern, index);
  if (quantifier === undefined) {
    return undefined;
  }
  // `*?`, `+?`, `??`, `{n,m}?`: a `?` after the quantifier itself.
  const lazy = quantifier.end - index > 1 && pattern[quantifier.end - 1] === '?';
  return { ...quantifier, ...countsAt(pattern, index), lazy };
}

/** Past one unit of a pattern a `|` cannot split: an escape, a set, a group, or a character. */
function pastUnit(pattern: string, index: number): number {
  const character = pattern[index];
  if (character === '\\') {
    return index + 2;
  }
  if (character === '[') {
    return afterCharacterClass(pattern, index);
  }
  return character === '(' ? afterGroup(pattern, index) : index + 1;
}

export function parseAlternatives(
  pattern: string,
  from: number,
  to: number,
): Alternatives | undefined {
  const alternatives: PatternNode[][] = [];
  let start = from;
  let index = from;
  while (index < to) {
    if (pattern[index] === '|') {
      const sequence = parseSequence(pattern, start, index);
      if (sequence === undefined) {
        return undefined;
      }
      alternatives.push(sequence);
      start = index + 1;
      index += 1;
    } else {
      index = pastUnit(pattern, index);
    }
  }
  const last = parseSequence(pattern, start, to);
  return last === undefined ? undefined : [...alternatives, last];
}

function parseSequence(pattern: string, from: number, to: number): PatternNode[] | undefined {
  const nodes: PatternNode[] = [];
  let index = from;
  while (index < to) {
    const parsed = nodeAt(pattern, index, to);
    if (parsed === undefined) {
      return undefined;
    }
    nodes.push(parsed.node);
    index = parsed.end;
  }
  return nodes;
}

function anchorAt(pattern: string, index: number): Parsed | undefined {
  const character = pattern[index];
  if (character === '^' || character === '$') {
    return { node: { kind: 'anchor', at: character === '^' ? 'start' : 'end' }, end: index + 1 };
  }
  const boundary = character === '\\' && (pattern[index + 1] === 'b' || pattern[index + 1] === 'B');
  return boundary ? { node: { kind: 'anchor', at: 'boundary' }, end: index + 2 } : undefined;
}

function groupAt(pattern: string, index: number, to: number): Parsed | undefined {
  const end = afterGroup(pattern, index);
  if (end > to || pattern[end - 1] !== ')') {
    return undefined;
  }
  const quantifier = countedAt(pattern, end);
  if (isLookaround(pattern, index)) {
    // A lookaround read again and again is no shape this reads.
    const behind = pattern.startsWith('(?<', index);
    const opener = behind ? '(?<='.length : '(?='.length;
    const alternatives = parseAlternatives(pattern, index + opener, end - 1);
    return quantifier !== undefined || alternatives === undefined
      ? undefined
      : { node: { kind: 'look', alternatives, behind }, end };
  }
  const contents = groupContents(pattern, index);
  const alternatives =
    contents === undefined ? undefined : parseAlternatives(pattern, contents, end - 1);
  return alternatives === undefined
    ? undefined
    : {
        node: { kind: 'group', alternatives, quantifier, fragment: pattern.slice(index, end - 1) },
        end: quantifier?.end ?? end,
      };
}

/**
 * A `{` that begins no quantifier, or a `}` or a `]` on its own: each the character itself, as the
 * web's legacy grammar reads them without the `u` flag — `(a+){two}` names the braces.
 */
function legacyLiteralAt(pattern: string, index: number): Atom | undefined {
  const character = pattern[index] ?? '';
  const literal =
    (character === '{' && quantifierAt(pattern, index) === undefined) ||
    character === '}' ||
    character === ']';
  return literal ? { end: index + 1, matches: (consumed) => consumed === character } : undefined;
}

/** The character a legacy literal (`legacyLiteralAt`) stands for, where the atom is one. */
function legacyChar(pattern: string, index: number, atom: Atom): string | undefined {
  const character = pattern[index] ?? '';
  return atom.end === index + 1 && '{}]'.includes(character) && atom.matches(character)
    ? character
    : undefined;
}

function nodeAt(pattern: string, index: number, to: number): Parsed | undefined {
  const anchor = anchorAt(pattern, index);
  if (anchor !== undefined) {
    // An assertion repeated, or made optional, is no shape this reads.
    return quantifierAt(pattern, anchor.end) === undefined ? anchor : undefined;
  }
  if (pattern[index] === '(') {
    return groupAt(pattern, index, to);
  }
  const atom = atomAt(pattern, index) ?? legacyLiteralAt(pattern, index);
  if (atom === undefined || atom.end > to) {
    return undefined;
  }
  const literal = literalAt(pattern, index);
  const quantifier = countedAt(pattern, atom.end);
  return {
    node: {
      kind: 'atom',
      atom,
      dot: pattern[index] === '.',
      literal: literal?.end === atom.end ? literal.char : legacyChar(pattern, index, atom),
      quantifier,
    },
    end: quantifier?.end ?? atom.end,
  };
}
