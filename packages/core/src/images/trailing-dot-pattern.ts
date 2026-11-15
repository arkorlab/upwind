import { MAX_SOURCE_LENGTH } from '../request/pattern-shape.ts';
import { afterCharacterClass, groupContents, isLookaround } from '../request/pattern-syntax.ts';
import { countedAt } from '../request/pattern-tree.ts';

/**
 * Rewrites explicit branch-final dot atoms (`\.` or non-negated character classes containing `.`)
 * outside negative lookarounds to be optional, while keeping mandatory delimiters intact in
 * earlier iterations of repeated groups. Returns `undefined` when no branch of `source` explicitly
 * spells a trailing dot.
 */

interface SpanRewrite {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

interface QuantifierBounds {
  readonly next: number;
  readonly min: number;
  readonly max: number;
  readonly lazy: string;
  readonly repeats: boolean;
}

interface RepeatedGroupSpan {
  readonly start: number;
  readonly end: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly quant: QuantifierBounds;
}

interface OpenGroup {
  readonly itemIndex: number;
  readonly sourceStart: number;
  readonly bodyStart: number;
  readonly lookaround: boolean;
  readonly negative: boolean;
  readonly unrollable: boolean;
  readonly allowRewrite: boolean;
  branchNullable: boolean;
  anyBranchNullable: boolean;
}

type PatternItem =
  | { readonly kind: 'anchor' }
  | { readonly kind: 'alt'; readonly openIndex: number }
  | { readonly kind: 'close'; readonly blocksInner: boolean }
  | {
      readonly kind: 'atom';
      readonly optional: boolean;
      readonly dotRewrite: SpanRewrite | undefined;
    }
  | {
      readonly kind: 'open';
      closeIndex: number;
      nullable: boolean;
      repeatedGroup: RepeatedGroupSpan | undefined;
    };

interface TokenizerState {
  readonly source: string;
  readonly stack: OpenGroup[];
  readonly items: PatternItem[];
  hasBackreference: boolean;
}

const ESCAPE_STEP = 2;
const LOOKAHEAD_LEN = 3;
const LOOKBEHIND_LEN = 4;
const NO_GROUP = -1;
const MAX_REWRITE_DEPTH = 8;
const BACKREF_CHAR = /^[1-9k]$/u;

function formatCountSuffix(min: number, max: number, lazy: string): string {
  if (min === 1 && max === 1) {
    return '';
  }
  if (min === 0 && max === 1) {
    return `?${lazy}`;
  }
  if (min === 0 && max === Infinity) {
    return `*${lazy}`;
  }
  if (max === Infinity) {
    return `{${String(min)},}${lazy}`;
  }
  return min === max ? `{${String(min)}}${lazy}` : `{${String(min)},${String(max)}}${lazy}`;
}

function readQuantifierBounds(source: string, afterUnit: number): QuantifierBounds {
  const counted = countedAt(source, afterUnit);
  if (
    counted === undefined ||
    !Number.isSafeInteger(counted.min) ||
    (counted.max !== Infinity && !Number.isSafeInteger(counted.max)) ||
    counted.min > counted.max
  ) {
    return { next: afterUnit, min: 1, max: 1, lazy: '', repeats: false };
  }
  return {
    next: counted.end,
    min: counted.min,
    max: counted.max,
    lazy: counted.lazy ? '?' : '',
    repeats: counted.repeats,
  };
}

function readAtomQuantifier(
  source: string,
  atomStart: number,
  atomEnd: number,
): {
  readonly next: number;
  readonly optional: boolean;
  readonly rewrite: SpanRewrite | undefined;
} {
  const quant = readQuantifierBounds(source, atomEnd);
  if (quant.min !== 1) {
    return { next: quant.next, optional: quant.min === 0, rewrite: undefined };
  }
  const suffix = formatCountSuffix(0, quant.max, quant.lazy);
  return {
    next: quant.next,
    optional: false,
    rewrite: {
      start: atomStart,
      end: quant.next,
      replacement: `(?:${source.slice(atomStart, atomEnd)})${suffix}`,
    },
  };
}

function readGroupPrefix(
  source: string,
  start: number,
): {
  readonly next: number;
  readonly lookaround: boolean;
  readonly negative: boolean;
  readonly unrollable: boolean;
} {
  const contents = groupContents(source, start);
  if (contents !== undefined) {
    return { next: contents, lookaround: false, negative: false, unrollable: true };
  }
  if (isLookaround(source, start)) {
    const behind = source.startsWith('(?<', start);
    const negative = source.startsWith('(?!', start) || source.startsWith('(?<!', start);
    return {
      next: start + (behind ? LOOKBEHIND_LEN : LOOKAHEAD_LEN),
      lookaround: true,
      negative,
      unrollable: false,
    };
  }
  const colon = source.indexOf(':', start + ESCAPE_STEP);
  const closeParen = source.indexOf(')', start + ESCAPE_STEP);
  const next =
    colon !== NO_GROUP && (closeParen === NO_GROUP || colon < closeParen)
      ? colon + 1
      : start + ESCAPE_STEP;
  return { next, lookaround: false, negative: false, unrollable: false };
}

function setSpellsLiteralDot(source: string, start: number, end: number): boolean {
  if (source[start + 1] === '^' || source[end - 1] !== ']') {
    return false;
  }
  let cursor = start + 1;
  const close = end - 1;
  while (cursor < close) {
    if (source[cursor] === '\\') {
      if (source[cursor + 1] === '.') {
        return true;
      }
      cursor += ESCAPE_STEP;
    } else if (source[cursor] === '.') {
      return true;
    } else {
      cursor += 1;
    }
  }
  return false;
}

function stripCaptures(fragment: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < fragment.length) {
    const current = fragment[cursor];
    switch (current) {
      case '\\': {
        out += fragment.slice(cursor, cursor + ESCAPE_STEP);
        cursor += ESCAPE_STEP;
        break;
      }
      case '[': {
        const end = afterCharacterClass(fragment, cursor);
        out += fragment.slice(cursor, end);
        cursor = end;
        break;
      }
      case '(': {
        const contents = groupContents(fragment, cursor);
        if (contents === undefined) {
          const prefix = readGroupPrefix(fragment, cursor);
          out += fragment.slice(cursor, prefix.next);
          cursor = prefix.next;
        } else {
          out += '(?:';
          cursor = contents;
        }
        break;
      }
      case undefined:
      default: {
        out += current ?? '';
        cursor += 1;
        break;
      }
    }
  }
  return out;
}

function markNonNullable(stack: readonly OpenGroup[]): void {
  const top = stack.at(-1);
  if (top !== undefined && !top.lookaround) {
    top.branchNullable = false;
  }
}

function openGroupAt(state: TokenizerState, cursor: number, allowRewrite: boolean): number {
  const prefix = readGroupPrefix(state.source, cursor);
  state.stack.push({
    itemIndex: state.items.length,
    sourceStart: cursor,
    bodyStart: prefix.next,
    lookaround: prefix.lookaround,
    negative: prefix.negative,
    unrollable: prefix.unrollable,
    allowRewrite: allowRewrite && !prefix.negative,
    branchNullable: true,
    anyBranchNullable: false,
  });
  state.items.push({
    kind: 'open',
    closeIndex: NO_GROUP,
    nullable: prefix.lookaround,
    repeatedGroup: undefined,
  });
  return prefix.next;
}

function closeGroupAt(state: TokenizerState, cursor: number): number {
  const closed = state.stack.pop();
  const quant = readQuantifierBounds(state.source, cursor + 1);
  const closeIndex = state.items.length;
  state.items.push({ kind: 'close', blocksInner: quant.repeats || quant.max === 0 });
  if (closed !== undefined) {
    const openItem = state.items[closed.itemIndex];
    const nullable =
      closed.lookaround || quant.min === 0 || closed.anyBranchNullable || closed.branchNullable;
    if (openItem?.kind === 'open') {
      openItem.closeIndex = closeIndex;
      openItem.nullable = nullable;
      if (!closed.lookaround && quant.repeats && closed.unrollable && closed.allowRewrite) {
        openItem.repeatedGroup = {
          start: closed.sourceStart,
          end: quant.next,
          bodyStart: closed.bodyStart,
          bodyEnd: cursor,
          quant,
        };
      }
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
    top.anyBranchNullable ||= top.branchNullable;
    top.branchNullable = true;
  }
  state.items.push({ kind: 'alt', openIndex: top?.itemIndex ?? NO_GROUP });
  return cursor + 1;
}

function appendAtom(
  state: TokenizerState,
  span: { readonly start: number; readonly end: number; readonly canRewriteDot: boolean },
): number {
  const quant = readAtomQuantifier(state.source, span.start, span.end);
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
  const escaped = state.source[cursor + 1] ?? '';
  state.hasBackreference ||= BACKREF_CHAR.test(escaped);
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
      return openGroupAt(state, cursor, allowRewrite);
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
      const end = afterCharacterClass(state.source, cursor);
      const canRewriteDot = allowRewrite && setSpellsLiteralDot(state.source, cursor, end);
      return appendAtom(state, { start: cursor, end, canRewriteDot });
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

function nextReachableIndex(
  items: readonly PatternItem[],
  cursor: number,
  item: PatternItem,
): number {
  switch (item.kind) {
    case 'anchor': {
      return cursor + 1;
    }
    case 'close': {
      return item.blocksInner ? NO_GROUP : cursor + 1;
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
        ? enclosing.closeIndex
        : NO_GROUP;
    }
    case 'atom': {
      return item.optional ? cursor + 1 : NO_GROUP;
    }
  }
}

function reachesPatternEnd(items: readonly PatternItem[], afterItem: number): boolean {
  let cursor = afterItem;
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

function unrollRepeatedGroup(
  source: string,
  repeated: RepeatedGroupSpan,
  depth: number,
): SpanRewrite | undefined {
  const prefixBody = stripCaptures(source.slice(repeated.bodyStart, repeated.bodyEnd));
  const finalBody = withoutTrailingDotAtDepth(prefixBody, depth + 1);
  if (finalBody === undefined) {
    return undefined;
  }
  const { quant } = repeated;
  const earlierSuffix = formatCountSuffix(Math.max(0, quant.min - 1), quant.max - 1, quant.lazy);
  const sequence = `(?:${prefixBody})${earlierSuffix}(?:${finalBody})`;
  const replacement = quant.min === 0 ? `(?:${sequence})?${quant.lazy}` : `(?:${sequence})`;
  return { start: repeated.start, end: repeated.end, replacement };
}

function rewriteForItem(
  source: string,
  items: readonly PatternItem[],
  entry: { readonly index: number; readonly item: PatternItem; readonly depth: number },
): SpanRewrite | undefined {
  const { index, item, depth } = entry;
  if (
    item.kind === 'atom' &&
    item.dotRewrite !== undefined &&
    reachesPatternEnd(items, index + 1)
  ) {
    return item.dotRewrite;
  }
  if (
    item.kind === 'open' &&
    item.repeatedGroup !== undefined &&
    item.closeIndex >= index &&
    reachesPatternEnd(items, item.closeIndex + 1)
  ) {
    return unrollRepeatedGroup(source, item.repeatedGroup, depth);
  }
  return undefined;
}

function withoutTrailingDotAtDepth(source: string, depth: number): string | undefined {
  if (depth >= MAX_REWRITE_DEPTH || source.length > MAX_SOURCE_LENGTH) {
    return undefined;
  }
  const state: TokenizerState = { source, stack: [], items: [], hasBackreference: false };
  let cursor = 0;
  while (cursor < source.length) {
    cursor = stepTokenizer(state, cursor);
  }
  if (state.hasBackreference) {
    return undefined;
  }
  const rewrites: SpanRewrite[] = [];
  for (const [index, item] of state.items.entries()) {
    const span = rewriteForItem(source, state.items, { index, item, depth });
    if (span !== undefined) {
      rewrites.push(span);
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

export function withoutTrailingDotSource(source: string): string | undefined {
  return withoutTrailingDotAtDepth(source, 0);
}
