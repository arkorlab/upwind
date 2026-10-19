import { afterCharacterClass, afterGroup, literalAt, quantifierAt } from './pattern-syntax.ts';
import { nestingDepth } from './pattern-tree.ts';
import { requiresLiteral } from './required-literal.ts';

const MAX_SOURCE_LENGTH = 4096;
const MAX_NESTING = 32;
const MAX_LITERAL_LENGTH = 64;
const MIN_LITERAL_LENGTH = 2;
const ASCII_START = 0x20;
const ASCII_END = 0x7f;

interface Unit {
  readonly end: number;
  readonly char?: string;
}

function unitAt(source: string, index: number): Unit {
  const literal = literalAt(source, index);
  if (literal !== undefined) {
    const quantified = quantifierAt(source, literal.end);
    const code = literal.char.codePointAt(0) ?? ASCII_END;
    return quantified === undefined && code >= ASCII_START && code < ASCII_END
      ? literal
      : { end: quantified?.end ?? literal.end };
  }
  if (source[index] === '(' || source[index] === '[') {
    const end =
      source[index] === '(' ? afterGroup(source, index) : afterCharacterClass(source, index);
    return { end: quantifierAt(source, end)?.end ?? end };
  }
  return { end: index + (source[index] === '\\' ? 2 : 1) };
}

/**
 * A bounded ASCII run outside groups, chosen only as a candidate. Its spelling alone is not a
 * proof: an alternative, for example, need not pass through this run at all.
 */
function candidate(source: string): string {
  let longest = '';
  let run = '';
  let index = 0;
  while (index < source.length) {
    const unit = unitAt(source, index);
    if (unit.char === undefined) {
      run = '';
    } else {
      run = (run + unit.char).slice(0, MAX_LITERAL_LENGTH);
      if (run.length > longest.length) longest = run;
    }
    index = unit.end;
  }
  return longest;
}

/**
 * A lower bound on a match's UTF-16 length, proved from an ASCII literal every match must contain.
 * Read only with the routing flags `''` and `'i'`: neither can make an ASCII literal consume fewer
 * code units. Unknown syntax or a candidate not proved necessary supplies no bound.
 */
export function requiredLiteralLength(source: string): number | undefined {
  if (source.length > MAX_SOURCE_LENGTH || nestingDepth(source) > MAX_NESTING) return undefined;
  const literal = candidate(source);
  return literal.length >= MIN_LITERAL_LENGTH && requiresLiteral(source, literal)
    ? literal.length
    : undefined;
}
