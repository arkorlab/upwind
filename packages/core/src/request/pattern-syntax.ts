/**
 * The pieces of a regular expression the safety check reads, as the engine that runs them reads
 * them: quantifiers, bracketed sets, groups and single atoms. Only what the check needs, and
 * conservative where it stops short — an atom it cannot read is reported as one that may match
 * anything, and so is a set with a member it cannot read, negated or not.
 *
 * Read as the edge compiles them: with no flags. Without `u` an escape means what the web's
 * legacy grammar says it does — `\u{2f}` is a `u` and the characters `{2f}`, not a slash, and
 * `\01` is one octal character — so an escape is read only in the spellings that mean one thing.
 */

export interface Quantifier {
  readonly end: number;
  readonly repeats: boolean;
  readonly optional: boolean;
}

/** One unit a quantifier applies to, and the characters it can consume. */
export interface Atom {
  readonly end: number;
  /** Whether the atom can consume `character`; a zero-width one consumes nothing. */
  readonly matches: (character: string) => boolean;
}

/** A single character the pattern names, and where its spelling ends. */
export interface Literal {
  readonly char: string;
  readonly end: number;
}

interface SetMember {
  readonly end: number;
  /** `undefined` for a member this check cannot read, which leaves the whole set unread. */
  readonly matches: ((character: string) => boolean) | undefined;
  /** The single character the member stands for, which can begin or end a range. */
  readonly char: string | undefined;
}

const HEX_RADIX = 16;
/** `\cA` … `\cZ` name the control character at the letter's code modulo 32. */
const CONTROL_LETTER_MODULUS = 32;
/** Characters that mean something unescaped, and so are never a literal where they stand. */
const SYNTAX_CHARACTERS: ReadonlySet<string> = new Set(String.raw`\()[]{}|?*+.^$`);
const NON_CAPTURING = '(?:';
const LOOKAROUNDS = ['(?=', '(?!', '(?<=', '(?<!'];
/** Escapes of single control characters, by the letter that names them. */
const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '0': '\0',
};
/** `\d`, `\w`, `\s`; their capitals are the complements. */
const SHORTHANDS: Readonly<Record<string, RegExp>> = { d: /\d/u, w: /\w/u, s: /\s/u };
/** The hex digits a `\u` escape takes four of and a `\x` escape two — no fewer, and no braces. */
const CODED_DIGITS: Readonly<Record<string, RegExp>> = { u: /^[\da-f]{4}/iu, x: /^[\da-f]{2}/iu };

/** The complete quantifier token, including a lazy suffix, when one starts at `index`. */
export function quantifierAt(pattern: string, index: number): Quantifier | undefined {
  const character = pattern[index];
  if (['*', '+', '?'].includes(character ?? '')) {
    return {
      end: index + (pattern[index + 1] === '?' ? 2 : 1),
      repeats: character !== '?',
      optional: character === '?',
    };
  }
  if (character !== '{') {
    return undefined;
  }
  const close = pattern.indexOf('}', index);
  if (close === -1) {
    return undefined;
  }
  const body = pattern.slice(index + 1, close);
  // A fixed outer count still backtracks over the partitions made by an inner repetition:
  // `(a+){20}` is just as unsuitable for a visitor-controlled value as the ranged form.
  // The upper bound decides whether it repeats: `{0,1}` is only optional and `{1,1}` is one
  // copy. An omitted upper bound is unbounded. Other brace text may be a literal without /u.
  const counts = /^(\d+)(?:,(\d*))?$/u.exec(body);
  // `$` can also match before a final newline; require the entire brace body to be numeric.
  if (counts?.[0] !== body) return undefined;
  const maximum = counts[2] ?? counts[1];
  return {
    end: close + (pattern[close + 1] === '?' ? 2 : 1),
    repeats: maximum === '' || Number(maximum) > 1,
    optional: Number(counts[1]) === 0 && Number(maximum) === 1,
  };
}

/** A closing bracket ends a class only when it is not escaped. */
export function afterCharacterClass(pattern: string, start: number): number {
  let index = start + 1;
  while (index < pattern.length) {
    if (pattern[index] === '\\') {
      index += 2;
    } else if (pattern[index] === ']') {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return pattern.length;
}

/** A lookahead or lookbehind: it consumes nothing, and the engine never backtracks into it. */
export function isLookaround(pattern: string, index: number): boolean {
  return LOOKAROUNDS.some((opening) => pattern.startsWith(opening, index));
}

/** Just past the parenthesis that closes the group opened at `open`, or the end of the pattern. */
export function afterGroup(pattern: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '[') {
      index = afterCharacterClass(pattern, index);
      continue;
    }
    depth += character === '(' ? 1 : 0;
    depth -= character === ')' ? 1 : 0;
    index += 1;
    if (depth === 0) {
      return index;
    }
  }
  return pattern.length;
}

/**
 * Where a group's contents begin: after `(`, `(?:` or a name. `undefined` for any other kind of
 * group — a lookaround, or a modifier group — whose contents are not simply its alternatives.
 */
export function groupContents(pattern: string, open: number): number | undefined {
  if (pattern[open + 1] !== '?') {
    return open + 1;
  }
  if (pattern.startsWith(NON_CAPTURING, open)) {
    return open + NON_CAPTURING.length;
  }
  if (pattern.startsWith('(?<', open) && !isLookaround(pattern, open)) {
    const close = pattern.indexOf('>', open);
    return close === -1 ? undefined : close + 1;
  }
  return undefined;
}

function shorthandMatches(letter: string, character: string): boolean {
  const lower = letter.toLowerCase();
  const within = SHORTHANDS[lower]?.test(character) ?? true;
  return letter === lower ? within : !within;
}

/** The character a `\u`, `\x` or `\c` escape names, and where it ends; `undefined` for none. */
function codedEscape(pattern: string, index: number): Literal | undefined {
  const letter = pattern[index + 1] ?? '';
  const rest = pattern.slice(index + 2);
  if (letter === 'c') {
    const named = rest[0] ?? '';
    return /^[a-z]$/iu.test(named)
      ? {
          char: String.fromCodePoint((named.codePointAt(0) ?? 0) % CONTROL_LETTER_MODULUS),
          end: index + 2 + named.length,
        }
      : undefined;
  }
  const digits = CODED_DIGITS[letter]?.exec(rest)?.[0];
  return digits === undefined
    ? undefined
    : {
        char: String.fromCodePoint(Number.parseInt(digits, HEX_RADIX)),
        end: index + 2 + digits.length,
      };
}

/**
 * The single character an escape stands for, when it stands for one. Any other letter or digit is
 * a class, an assertion, a backreference, or an escape this does not read.
 */
function escapedCharacter(pattern: string, index: number): Literal | undefined {
  const letter = pattern[index + 1] ?? '';
  // `\0` then a digit is an octal escape of more than one digit, not a NUL beside a digit.
  if (letter === '0' && /\d/u.test(pattern[index + 2] ?? '')) {
    return undefined;
  }
  const control = CONTROL_ESCAPES[letter];
  if (control !== undefined) {
    return { char: control, end: index + 2 };
  }
  if (/[cux]/u.test(letter)) {
    return codedEscape(pattern, index);
  }
  return letter === '' || /[\da-z]/iu.test(letter) ? undefined : { char: letter, end: index + 2 };
}

/**
 * One escape, as an atom. A backreference is reported as `undefined`: it can repeat whatever its
 * group took, which is not a set of characters this check can reason about.
 */
function escapeAt(pattern: string, index: number): Atom | undefined {
  const letter = pattern[index + 1] ?? '';
  if (/[1-9k]/u.test(letter)) {
    return undefined;
  }
  if (/[dsw]/iu.test(letter)) {
    return { end: index + 2, matches: (character) => shorthandMatches(letter, character) };
  }
  if (letter === 'b' || letter === 'B') {
    return { end: index + 2, matches: () => false };
  }
  const literal = escapedCharacter(pattern, index);
  return literal === undefined
    ? { end: index + 2, matches: () => true }
    : { end: literal.end, matches: (character) => character === literal.char };
}

function setMemberAt(pattern: string, index: number): SetMember {
  if (pattern[index] !== '\\') {
    const char = pattern[index] ?? '';
    return { end: index + 1, matches: (character) => character === char, char };
  }
  const letter = pattern[index + 1] ?? '';
  // In a set, `\b` is a backspace rather than a word boundary.
  if (letter === 'b') {
    return { end: index + 2, matches: (character) => character === '\b', char: '\b' };
  }
  if (/[dsw]/iu.test(letter)) {
    const matches = (character: string): boolean => shorthandMatches(letter, character);
    return { end: index + 2, matches, char: undefined };
  }
  const literal = escapedCharacter(pattern, index);
  return literal === undefined
    ? { end: index + 2, matches: undefined, char: undefined }
    : { end: literal.end, matches: (character) => character === literal.char, char: literal.char };
}

/**
 * One member, or a range between two; a shorthand beside a hyphen makes the hyphen a member.
 * `undefined` when either is a member this check cannot read.
 */
function membersOf(
  low: SetMember,
  high: SetMember | undefined,
): ((character: string) => boolean)[] | undefined {
  if (low.matches === undefined || high?.matches === undefined) {
    return high === undefined && low.matches !== undefined ? [low.matches] : undefined;
  }
  if (low.char === undefined || high.char === undefined) {
    return [low.matches, (character) => character === '-', high.matches];
  }
  const from = low.char.codePointAt(0) ?? 0;
  const to = high.char.codePointAt(0) ?? 0;
  return [
    (character) => {
      const point = character.codePointAt(0) ?? -1;
      return point >= from && point <= to;
    },
  ];
}

/** A bracketed set as one atom: what it can consume, a negated set included. */
function characterSetAt(pattern: string, start: number): Atom {
  const negated = pattern[start + 1] === '^';
  const end = afterCharacterClass(pattern, start);
  const close = end - 1;
  const members: ((character: string) => boolean)[] = [];
  let index = start + (negated ? 2 : 1);
  while (index < close) {
    const low = setMemberAt(pattern, index);
    const ranged = low.char !== undefined && pattern[low.end] === '-' && low.end + 1 < close;
    const high = ranged ? setMemberAt(pattern, low.end + 1) : undefined;
    const read = membersOf(low, high);
    if (read === undefined) {
      // Negated, a member read as matching everything would leave the set matching nothing — the
      // opposite of what an unread member has to be taken for. So the whole set may match anything.
      return { end, matches: () => true };
    }
    members.push(...read);
    index = high?.end ?? low.end;
  }
  const within = (character: string): boolean => members.some((member) => member(character));
  return { end, matches: negated ? (character) => !within(character) : within };
}

/**
 * The atom that starts at `index`, if it is one a quantifier could apply to. `undefined` for what
 * is not an atom on its own — a group boundary, an alternative, a stray quantifier — or for an
 * atom this check cannot read.
 */
export function atomAt(pattern: string, index: number): Atom | undefined {
  const character = pattern[index] ?? '';
  switch (character) {
    case '\\': {
      return escapeAt(pattern, index);
    }
    case '[': {
      return characterSetAt(pattern, index);
    }
    // `.` misses only line terminators, which no delimiter is: it is read as matching anything.
    case '.': {
      return { end: index + 1, matches: () => true };
    }
    case '^':
    case '$': {
      return { end: index + 1, matches: () => false };
    }
    default: {
      return SYNTAX_CHARACTERS.has(character)
        ? undefined
        : { end: index + 1, matches: (consumed) => consumed === character };
    }
  }
}

/** A single literal character at `index`, spelled plainly or as an escape. */
export function literalAt(pattern: string, index: number): Literal | undefined {
  const character = pattern[index] ?? '';
  if (character === '\\') {
    return escapedCharacter(pattern, index);
  }
  return character === '' || SYNTAX_CHARACTERS.has(character)
    ? undefined
    : { char: character, end: index + 1 };
}
