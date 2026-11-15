/**
 * Rewrites explicit branch-final dot atoms (`\.` or non-negated character classes containing `.`)
 * outside negative lookarounds to be optional, or returns `undefined` when no branch of `source`
 * explicitly spells a trailing dot.
 *
 * Testing both the original pattern against `${normalizedHostname}.` and this rewritten pattern
 * against `normalizedHostname` preserves explicit trailing-dot `remotePatterns` (including
 * alternations, nested groups, and `[.]` character classes) without allowing unescaped wildcards
 * (`.+`) or negative-lookahead exclusions (`^(?!evil\.com$).+$`) to be bypassed via a trailing dot.
 */

interface SpanRewrite {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

interface OpenGroup {
  readonly itemIndex: number;
  readonly lookaround: boolean;
  readonly negative: boolean;
  branchNullable: boolean;
  anyBranchNullable: boolean;
}

type PatternItem =
  | { readonly kind: 'anchor' }
  | { readonly kind: 'alt'; readonly openIndex: number }
  | { readonly kind: 'close' }
  | {
      readonly kind: 'atom';
      readonly optional: boolean;
      readonly dotRewrite: SpanRewrite | undefined;
    }
  | {
      readonly kind: 'open';
      closeIndex: number;
      nullable: boolean;
    };

interface QuantifierResult {
  readonly next: number;
  readonly optional: boolean;
  readonly rewrite: SpanRewrite | undefined;
}

interface TokenizerState {
  readonly source: string;
  readonly stack: OpenGroup[];
  readonly items: PatternItem[];
}

const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const ESCAPE_STEP = 2;
const NO_GROUP = -1;

const GROUP_PREFIXES = [
  { text: '(?<=', lookaround: true, negative: false },
  { text: '(?<!', lookaround: true, negative: true },
  { text: '(?=', lookaround: true, negative: false },
  { text: '(?!', lookaround: true, negative: true },
  { text: '(?:', lookaround: false, negative: false },
] as const;

function readDigits(
  source: string,
  start: number,
): { readonly value: string; readonly next: number } {
  let cursor = start;
  while (cursor < source.length) {
    const code = source.codePointAt(cursor) ?? 0;
    if (code < DIGIT_ZERO || code > DIGIT_NINE) {
      break;
    }
    cursor += 1;
  }
  return { value: source.slice(start, cursor), next: cursor };
}

function rangeQuantifierSymbol(upper: string): string {
  if (upper === '') {
    return '*';
  }
  if (upper === '1') {
    return '?';
  }
  return `{0,${upper}}`;
}

function braceQuantifier(
  source: string,
  atomStart: number,
  atomEnd: number,
): QuantifierResult | undefined {
  const first = readDigits(source, atomEnd + 1);
  if (first.value === '') {
    return undefined;
  }
  const min = Number(first.value);
  const atomText = source.slice(atomStart, atomEnd);
  if (source[first.next] === '}') {
    const lazy = source[first.next + 1] === '?' ? '?' : '';
    const next = first.next + 1 + lazy.length;
    const rewrite =
      min === 1
        ? { start: atomStart, end: next, replacement: `(?:${atomText})?${lazy}` }
        : undefined;
    return { next, optional: min === 0, rewrite };
  }
  if (source[first.next] !== ',') {
    return undefined;
  }
  const second = readDigits(source, first.next + 1);
  if (source[second.next] !== '}') {
    return undefined;
  }
  const lazy = source[second.next + 1] === '?' ? '?' : '';
  const next = second.next + 1 + lazy.length;
  if (min !== 1) {
    return { next, optional: min === 0, rewrite: undefined };
  }
  const quant = rangeQuantifierSymbol(second.value);
  return {
    next,
    optional: false,
    rewrite: { start: atomStart, end: next, replacement: `(?:${atomText})${quant}${lazy}` },
  };
}

function readQuantifier(source: string, atomStart: number, atomEnd: number): QuantifierResult {
  const marker = source[atomEnd];
  const atomText = source.slice(atomStart, atomEnd);
  if (marker === '?' || marker === '*') {
    const lazy = source[atomEnd + 1] === '?' ? 1 : 0;
    return { next: atomEnd + 1 + lazy, optional: true, rewrite: undefined };
  }
  if (marker === '+') {
    const lazy = source[atomEnd + 1] === '?' ? '?' : '';
    const next = atomEnd + 1 + lazy.length;
    return {
      next,
      optional: false,
      rewrite: { start: atomStart, end: next, replacement: `(?:${atomText})*${lazy}` },
    };
  }
  if (marker === '{') {
    const braced = braceQuantifier(source, atomStart, atomEnd);
    if (braced !== undefined) {
      return braced;
    }
  }
  return {
    next: atomEnd,
    optional: false,
    rewrite: { start: atomStart, end: atomEnd, replacement: `(?:${atomText})?` },
  };
}

function readGroupPrefix(
  source: string,
  start: number,
): { readonly next: number; readonly lookaround: boolean; readonly negative: boolean } {
  if (source[start + 1] !== '?') {
    return { next: start + 1, lookaround: false, negative: false };
  }
  for (const prefix of GROUP_PREFIXES) {
    if (source.startsWith(prefix.text, start)) {
      return {
        next: start + prefix.text.length,
        lookaround: prefix.lookaround,
        negative: prefix.negative,
      };
    }
  }
  if (source[start + ESCAPE_STEP] === '<') {
    const closeAngle = source.indexOf('>', start + ESCAPE_STEP + 1);
    const angleIndex = closeAngle === NO_GROUP ? start + ESCAPE_STEP : closeAngle;
    return { next: angleIndex + 1, lookaround: false, negative: false };
  }
  const colon = source.indexOf(':', start + ESCAPE_STEP);
  const closeParen = source.indexOf(')', start + ESCAPE_STEP);
  const next =
    colon !== NO_GROUP && (closeParen === NO_GROUP || colon < closeParen)
      ? colon + 1
      : start + ESCAPE_STEP;
  return { next, lookaround: false, negative: false };
}

function readCharacterClass(
  source: string,
  start: number,
): { readonly end: number; readonly spellsDot: boolean } {
  const negated = source[start + 1] === '^';
  let cursor = start + (negated ? ESCAPE_STEP : 1);
  let hasLiteralDot = false;
  while (cursor < source.length) {
    const current = source[cursor];
    if (current === '\\') {
      if (source[cursor + 1] === '.') {
        hasLiteralDot = true;
      }
      cursor += ESCAPE_STEP;
    } else if (current === ']') {
      return { end: cursor + 1, spellsDot: !negated && hasLiteralDot };
    } else {
      if (current === '.') {
        hasLiteralDot = true;
      }
      cursor += 1;
    }
  }
  return { end: source.length, spellsDot: false };
}

function markNonNullable(stack: readonly OpenGroup[]): void {
  const top = stack.at(-1);
  if (top !== undefined && !top.lookaround) {
    top.branchNullable = false;
  }
}

function openGroupAt(state: TokenizerState, cursor: number): number {
  const prefix = readGroupPrefix(state.source, cursor);
  state.stack.push({
    itemIndex: state.items.length,
    lookaround: prefix.lookaround,
    negative: prefix.negative,
    branchNullable: true,
    anyBranchNullable: false,
  });
  state.items.push({ kind: 'open', closeIndex: NO_GROUP, nullable: prefix.lookaround });
  return prefix.next;
}

function closeGroupAt(state: TokenizerState, cursor: number): number {
  const closed = state.stack.pop();
  const quant = readQuantifier(state.source, cursor, cursor + 1);
  const closeIndex = state.items.length;
  state.items.push({ kind: 'close' });
  if (closed !== undefined) {
    const openItem = state.items[closed.itemIndex];
    const nullable =
      closed.lookaround || quant.optional || closed.anyBranchNullable || closed.branchNullable;
    if (openItem?.kind === 'open') {
      openItem.closeIndex = closeIndex;
      openItem.nullable = nullable;
    }
    if (!nullable) {
      markNonNullable(state.stack);
    }
  }
  return quant.next;
}

function altAt(state: TokenizerState, cursor: number): number {
  const top = state.stack.at(-1);
  if (top !== undefined) {
    if (top.branchNullable) {
      top.anyBranchNullable = true;
    }
    top.branchNullable = true;
  }
  state.items.push({ kind: 'alt', openIndex: top?.itemIndex ?? NO_GROUP });
  return cursor + 1;
}

function appendAtom(
  state: TokenizerState,
  span: { readonly start: number; readonly end: number; readonly canRewriteDot: boolean },
): number {
  const quant = readQuantifier(state.source, span.start, span.end);
  state.items.push({
    kind: 'atom',
    optional: quant.optional,
    dotRewrite: span.canRewriteDot ? quant.rewrite : undefined,
  });
  if (!quant.optional) {
    markNonNullable(state.stack);
  }
  return quant.next;
}

function escapedAt(state: TokenizerState, cursor: number, allowRewrite: boolean): number {
  const escaped = state.source[cursor + 1];
  if (escaped === 'b' || escaped === 'B') {
    state.items.push({ kind: 'anchor' });
    return cursor + ESCAPE_STEP;
  }
  const end = Math.min(cursor + ESCAPE_STEP, state.source.length);
  return appendAtom(state, { start: cursor, end, canRewriteDot: escaped === '.' && allowRewrite });
}

function stepTokenizer(state: TokenizerState, cursor: number): number {
  const allowRewrite = state.stack.every((group) => !group.negative);
  switch (state.source[cursor]) {
    case '(': {
      return openGroupAt(state, cursor);
    }
    case ')': {
      return closeGroupAt(state, cursor);
    }
    case '|': {
      return altAt(state, cursor);
    }
    case '^':
    case '$': {
      state.items.push({ kind: 'anchor' });
      return cursor + 1;
    }
    case '[': {
      const parsed = readCharacterClass(state.source, cursor);
      return appendAtom(state, {
        start: cursor,
        end: parsed.end,
        canRewriteDot: parsed.spellsDot && allowRewrite,
      });
    }
    case '\\': {
      return escapedAt(state, cursor, allowRewrite);
    }
    case undefined:
    default: {
      return appendAtom(state, { start: cursor, end: cursor + 1, canRewriteDot: false });
    }
  }
}

function tokenizePattern(source: string): PatternItem[] {
  const state: TokenizerState = { source, stack: [], items: [] };
  let cursor = 0;
  while (cursor < source.length) {
    cursor = stepTokenizer(state, cursor);
  }
  return state.items;
}

function nextReachableIndex(
  items: readonly PatternItem[],
  cursor: number,
  item: PatternItem,
): number {
  switch (item.kind) {
    case 'anchor':
    case 'close': {
      return cursor + 1;
    }
    case 'open': {
      return item.nullable && item.closeIndex >= cursor ? item.closeIndex + 1 : NO_GROUP;
    }
    case 'alt': {
      if (item.openIndex === NO_GROUP) {
        return items.length;
      }
      const enclosing = items[item.openIndex];
      return enclosing?.kind === 'open' && enclosing.closeIndex >= cursor
        ? enclosing.closeIndex + 1
        : NO_GROUP;
    }
    case 'atom': {
      return item.optional ? cursor + 1 : NO_GROUP;
    }
  }
}

function reachesPatternEnd(items: readonly PatternItem[], afterAtom: number): boolean {
  let cursor = afterAtom;
  while (cursor < items.length) {
    const item = items[cursor];
    if (item === undefined) {
      break;
    }
    const stepped = nextReachableIndex(items, cursor, item);
    if (stepped === NO_GROUP) {
      return false;
    }
    cursor = stepped;
  }
  return true;
}

export function withoutTrailingDotSource(source: string): string | undefined {
  const items = tokenizePattern(source);
  const rewrites: SpanRewrite[] = [];
  for (const [index, item] of items.entries()) {
    if (
      item.kind === 'atom' &&
      item.dotRewrite !== undefined &&
      reachesPatternEnd(items, index + 1)
    ) {
      rewrites.push(item.dotRewrite);
    }
  }
  if (rewrites.length === 0) {
    return undefined;
  }
  let rewritten = '';
  let lastEnd = 0;
  for (const span of rewrites) {
    rewritten += source.slice(lastEnd, span.start) + span.replacement;
    lastEnd = span.end;
  }
  return rewritten + source.slice(lastEnd);
}
