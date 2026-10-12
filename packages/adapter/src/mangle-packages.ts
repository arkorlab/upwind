import { decode, encode, type SourceMapSegment } from '@jridgewell/sourcemap-codec';
import type { Node, Program } from '@oxc-project/types';
import type { ExistingRawSourceMap, Plugin } from 'rolldown';
import { minifySync, parseSync } from 'rolldown/utils';

import { isUnder } from './fs.ts';

/**
 * The CommonJS modules a Function bundles from a package's own files — Next.js's server
 * (`next/dist/server`, `shared`, `lib`), and whatever else the build leaves to the Function in
 * CommonJS, React among them — with their variables and parameters renamed short, one module at a
 * time, and every function and class keeping its name.
 *
 * One module at a time, because most of a Function's code was minified by the build that made it,
 * and renaming it again costs a prerender its resume. The names Turbopack gave its chunks' code,
 * and Next.js's own build its precompiled runtimes' (`next/dist/compiled`), are the names a
 * prerender ran under, and React reads a page's postponed state back by the names of the
 * components that rendered it: with the whole of `app.cjs` mangled, every resume of
 * `fixtures/next-minimal` fell back to client rendering ("Expected the resume to render <sl> in
 * this slot but instead it rendered <vs>"). Kept, as `keepNames` keeps them, those names are one or
 * two letters long, which takes those letters from every other name in the bundle: the whole of
 * `app.cjs` came out 1.6% larger than not renaming at all. A module renamed on its own takes
 * nothing from another, and the code written to be read — about 350 KB of the fixture's app
 * Function — is what has names worth shortening.
 *
 * Only CommonJS. An ES module's top level is hoisted into the bundle's own, where every module's
 * short names would meet and be renamed apart again.
 *
 * A module that does not come out smaller is left as it was: a package that ships minified code,
 * whose names would only grow. Nothing renamed is a name a stack trace prints — a function's or a
 * class's, or one a frame takes from the binding it was assigned to — nor one another module reads,
 * since a CommonJS module is wrapped in a function of its own and read through its `exports`. The
 * module's map is handed on, for whatever map the bundle is written with.
 *
 * The minifier prints a module without its comments, `/*#__PURE__*\/` among them, and an annotation
 * is what lets the bundler drop a call whose result nothing reads, as it bundles and as it
 * minifies. So each one is put back before the call it marked (`withAnnotations`). A module that
 * marks a function instead (`#__NO_SIDE_EFFECTS__`) is left as it was written.
 */

/** A package's file, by its path: what the build installed rather than what it wrote. */
const PACKAGE_FILE = /[/\\]node_modules[/\\].+\.c?js$/u;
/** Minified by Next.js's own build, the page runtime among them: see above. */
const PRECOMPILED = /[/\\]node_modules[/\\]next[/\\]dist[/\\]compiled[/\\]/u;

/** As each module is printed, renamed or not, to tell which is the smaller. */
const PRINTED = { module: false, compress: false, codegen: { removeWhitespace: true } } as const;

/** What marks the call after it as free of side effects, as a bundler reads it. */
const PURE = /^\s*[#@]__PURE__\s*$/u;
/** What marks a function as free of side effects; nothing here puts one back. */
const NO_SIDE_EFFECTS = /^\s*[#@]__NO_SIDE_EFFECTS__\s*$/u;
/**
 * The annotation as it is put back, after a space: printed without whitespace, a call after a
 * division follows the `/` directly, and `//*@__PURE__*\/` would make the rest of the line a
 * comment — the whole of the module, which the printer writes on one line.
 */
const PURE_COMMENT = ' /*@__PURE__*/';

const FUNCTIONS: ReadonlySet<string> = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);
const CALLS: ReadonlySet<string> = new Set(['CallExpression', 'NewExpression']);

/** A node on the way down, with what the checks below need to know of where it is. */
interface Visit {
  readonly node: Node;
  /** Whether a declaration here is at the top level of a function or of the module. */
  readonly topLevel: boolean;
  /** Whether this is the block that is a function's body. */
  readonly functionBody: boolean;
}

/** What one walk of a module finds. */
interface Walked {
  /** Where each call and `new` starts, in the order the walk meets them. */
  readonly calls: number[];
  /** Whether the module has code the mangler would rename wrongly (`isUnsafe`). */
  readonly unsafe: boolean;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** Whether the module opens with `"use strict"`, which makes all of it strict. */
function isStrict(program: Program): boolean {
  return program.body.some(
    (statement) => 'directive' in statement && statement.directive === 'use strict',
  );
}

/**
 * What the pinned mangler (Oxc 0.153.0, as Rolldown carries it) renames wrongly, each reproduced
 * with the options used here and open upstream (oxc-project/oxc#24331, #26485):
 *
 * - a catch parameter taken apart whose key or default reads a binding the catch body declares
 *   again (`catch ({ [a]: b }) { let a }`, `catch ({ x = a }) { let a }`): the three get one name,
 *   and the read throws in its own temporal dead zone;
 * - a direct `eval`, which reads private names (`#field`) the mangler renamed;
 * - in sloppy code, a function declared in a block or a `switch` case, which Annex B also binds
 *   in the function around it: the mangler renames that binding apart from the function.
 *
 * A module with any of them is left as it was written. Each is rare in what a package ships, and
 * `"use strict"`, which every module of Next.js's opens with, rules out the last. (A `with`
 * statement is renamed wrongly too, oxc-project/oxc#25600, but Rolldown refuses to bundle one.)
 */
function isUnsafe(visit: Visit, strict: boolean): boolean {
  const { node } = visit;
  return (
    (node.type === 'CatchClause' && node.param !== null && node.param.type !== 'Identifier') ||
    (node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'eval') ||
    (!strict && !visit.topLevel && node.type === 'FunctionDeclaration')
  );
}

/**
 * Put the nodes directly under `visit` on `pending`, with where each one is, the last first: the
 * walk then meets them in the order the parser lists them.
 */
function pushChildren(visit: Visit, pending: Visit[]): void {
  const { node } = visit;
  const topLevel =
    node.type === 'Program' ||
    node.type === 'StaticBlock' ||
    (node.type === 'BlockStatement' && visit.functionBody);
  const children: Visit[] = [];
  for (const [key, value] of Object.entries(node)) {
    // A parent link, when the parser adds one, would lead back up.
    if (key === 'parent') {
      continue;
    }
    const functionBody = FUNCTIONS.has(node.type) && key === 'body';
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const child of values) {
      if (isNode(child)) {
        children.push({ node: child, topLevel, functionBody });
      }
    }
  }
  for (let at = children.length - 1; at >= 0; at -= 1) {
    const child = children[at];
    if (child !== undefined) {
      pending.push(child);
    }
  }
}

/**
 * The calls of `program` in the order a walk from the top meets them, which the printer keeps:
 * renamed without compression, a module has the same calls in the same order. And, where `strict`
 * is given, whether anything in it is what the mangler renames wrongly.
 */
function walk(program: Program, strict?: boolean): Walked {
  const calls: number[] = [];
  let unsafe = false;
  const pending: Visit[] = [{ node: program, topLevel: true, functionBody: false }];
  for (let visit = pending.pop(); visit !== undefined; visit = pending.pop()) {
    if (CALLS.has(visit.node.type)) {
      calls.push(visit.node.start);
    }
    if (strict !== undefined) {
      unsafe ||= isUnsafe(visit, strict);
    }
    pushChildren(visit, pending);
  }
  return { calls, unsafe };
}

/** Where the code after `end` starts, past the whitespace between. */
function nextCode(code: string, end: number): number {
  let at = end;
  while (at < code.length && /\s/u.test(code.charAt(at))) {
    at += 1;
  }
  return at;
}

/**
 * Which of the module's calls, by their place among them all, an annotation marks: the first call
 * that starts where the code after the comment does. An annotation before anything else marks
 * nothing a bundler reads, and is let go.
 */
function annotatedCalls(
  code: string,
  comments: readonly { readonly value: string; readonly end: number }[],
  calls: readonly number[],
): number[] {
  const marked = new Set(
    comments
      .filter((comment) => PURE.test(comment.value))
      .map((comment) => nextCode(code, comment.end)),
  );
  const places: number[] = [];
  for (const [place, start] of calls.entries()) {
    if (marked.delete(start)) {
      places.push(place);
    }
  }
  return places;
}

/** Each of `offsets`, in order, as its line and column in `code`. */
function positionsOf(code: string, offsets: readonly number[]): Map<number, number[]> {
  const byLine = new Map<number, number[]>();
  let line = 0;
  let lineStart = 0;
  let next = code.indexOf('\n');
  for (const offset of offsets) {
    while (next !== -1 && next < offset) {
      line += 1;
      lineStart = next + 1;
      next = code.indexOf('\n', lineStart);
    }
    byLine.set(line, [...(byLine.get(line) ?? []), offset - lineStart]);
  }
  return byLine;
}

/**
 * `code` with an annotation put back at each of `offsets`, and `map` moved to match: every mapping
 * at or past an insertion on its line moves along by the annotation's length.
 */
function withAnnotations(
  code: string,
  map: ExistingRawSourceMap,
  offsets: readonly number[],
): { code: string; map: ExistingRawSourceMap } {
  const sorted = [...new Set(offsets)].toSorted((a, b) => a - b);
  let annotated = '';
  let from = 0;
  for (const offset of sorted) {
    annotated += `${code.slice(from, offset)}${PURE_COMMENT}`;
    from = offset;
  }
  annotated += code.slice(from);
  const byLine = positionsOf(code, sorted);
  const mappings = decode(map.mappings).map((segments, line) => {
    const columns = byLine.get(line);
    if (columns === undefined) {
      return segments;
    }
    return segments.map((segment): SourceMapSegment => {
      const moved: SourceMapSegment = [...segment];
      moved[0] += columns.filter((column) => column <= segment[0]).length * PURE_COMMENT.length;
      return moved;
    });
  });
  return { code: annotated, map: { ...map, mappings: encode(mappings) } };
}

/**
 * The module renamed, with its map; `undefined` where it is not CommonJS, where the mangler would
 * rename it wrongly (`isUnsafe`) or its annotations could not be put back, or where it comes out
 * no smaller.
 */
function renamed(
  id: string,
  code: string,
): { code: string; map: ExistingRawSourceMap } | undefined {
  const parsed = parseSync(id, code, { sourceType: 'unambiguous' });
  if (
    parsed.errors.length > 0 ||
    parsed.module.hasModuleSyntax ||
    parsed.comments.some((comment) => NO_SIDE_EFFECTS.test(comment.value))
  ) {
    return undefined;
  }
  const { program } = parsed;
  const written = walk(program, isStrict(program));
  if (written.unsafe) {
    return undefined;
  }
  const mangled = minifySync(id, code, {
    ...PRINTED,
    mangle: { toplevel: true, keepNames: true },
    sourcemap: true,
  });
  if (mangled.errors.length > 0 || mangled.map === undefined) {
    return undefined;
  }
  const kept = minifySync(id, code, { ...PRINTED, mangle: false });
  if (kept.errors.length > 0 || mangled.code.length >= kept.code.length) {
    return undefined;
  }
  const places = annotatedCalls(code, parsed.comments, written.calls);
  if (places.length === 0) {
    return { code: mangled.code, map: mangled.map };
  }
  const reparsed = parseSync(id, mangled.code, { sourceType: 'script' });
  const printed = walk(reparsed.program);
  // The printer keeps every call in its place; a module where it did not is left as written
  // rather than given its annotations back in the wrong places.
  if (reparsed.errors.length > 0 || printed.calls.length !== written.calls.length) {
    return undefined;
  }
  return withAnnotations(
    mangled.code,
    mangled.map,
    places.flatMap((place) => printed.calls[place] ?? []),
  );
}

/**
 * Renames the locals of each CommonJS module of a package as it is loaded. Last among a bundle's
 * plugins, so that every other one reads a module as it was written, a patch's rewrite included;
 * the build's own output (`distDir`), Turbopack's chunks, is left as it is.
 */
export function manglePackagesPlugin(distDir: string): Plugin {
  return {
    name: 'arkor-mangle-packages',
    transform: {
      filter: { id: { include: PACKAGE_FILE, exclude: PRECOMPILED } },
      handler: (code, id) => (isUnder(distDir, id) ? null : (renamed(id, code) ?? null)),
    },
  };
}
