/**
 * The patterns of a list of rules — dynamic routes, redirects and rewrites, header rules,
 * middleware matchers, as Next.js compiled and ordered them — compiled once per list rather than
 * once per request that reads them.
 *
 * A request reads every rule ahead of the first that holds for it, and a pattern compiled where it
 * was read cost a real application's document a few hundred microseconds in front of its first
 * byte: 637 dynamic routes, read in order, every one of them compiled again. So a list is compiled
 * the first time it is read, keyed by the list itself — which a manifest holds for as long as it
 * is served, and which goes when the manifest does.
 *
 * Compiled as Next.js compiled them for its own router, without the unicode flag. A pattern that
 * does not compile is compiled again where it is read, and throws there as it always has: for the
 * request that reaches it, and for no other.
 */

export interface Patterned {
  readonly sourceRegex: string;
}

/** `''` as the dynamic routes and the rules of `next.config` are matched; `'i'` as a middleware's. */
type PatternFlags = '' | 'i';

export interface CompiledRule<T extends Patterned> {
  readonly rule: T;
  /** The rule's pattern, compiled; `undefined` for one that does not compile. */
  readonly pattern: RegExp | undefined;
  readonly flags: PatternFlags;
}

const compiledLists: Readonly<
  Record<PatternFlags, WeakMap<readonly Patterned[], readonly CompiledRule<Patterned>[]>>
> = { '': new WeakMap(), i: new WeakMap() };

function compile(source: string, flags: PatternFlags): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- as Next.js compiled it
  return new RegExp(source, flags);
}

function compileOnce<T extends Patterned>(rule: T, flags: PatternFlags): CompiledRule<T> {
  try {
    return { rule, pattern: compile(rule.sourceRegex, flags), flags };
  } catch {
    return { rule, pattern: undefined, flags };
  }
}

/** Each rule of `rules` beside its pattern, compiled the first time the list is read. */
export function compiledRules<T extends Patterned>(
  rules: readonly T[],
  flags: PatternFlags = '',
): readonly CompiledRule<T>[] {
  const cache = compiledLists[flags];
  // Keyed by the list alone, so what is read back is what `rules` was compiled into.
  let compiled = cache.get(rules) as readonly CompiledRule<T>[] | undefined;
  if (compiled === undefined) {
    compiled = rules.map((rule) => compileOnce(rule, flags));
    cache.set(rules, compiled);
  }
  return compiled;
}

/** The rule's pattern: compiled once, or — for one that does not compile — again, to throw. */
export function patternOf(compiled: CompiledRule<Patterned>): RegExp {
  return compiled.pattern ?? compile(compiled.rule.sourceRegex, compiled.flags);
}
