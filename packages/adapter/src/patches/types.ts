/**
 * A patch is a build-time rewrite of one file of Next.js's Node.js output, for a place where it
 * reaches for something workerd does not have. Each is a pure function of the file's source and
 * the build's context: no bundler, no file system. That is what makes them testable one by one,
 * against the installed Next.js, and what makes a change of bundler (see `rolldown.ts`) a change
 * of the one file that connects them.
 *
 * A patch knows how many places it expects to rewrite. Fewer means Next.js moved the code and the
 * rewrite silently missed it; more means it matched something it never meant to. Both fail the
 * build: a Function that starts with a `require("vm")` or a chunk loader still resolving paths does
 * not fail until the first request that needs it.
 *
 * Which Next.js versions the patches are held to is one declaration, `SUPPORTED_NEXT_RANGE` in
 * `versions.ts`, and `scripts/check-patches.ts` applies every patch to every release in it. A
 * patch carries no version list of its own: one that stopped matching a release the others still
 * match is not a patch with a narrower range, it is the notice that the floor has moved.
 */

/**
 * A kind of copy of the thing a patch rewrites.
 *
 * Next.js ships the same module more than once, and a Function loads whichever copies its build
 * reached for: the file under `dist/`, the ESM one beside it, the one bundled into each compiled
 * server runtime, a vendored package's own — and, for what `next build` *writes* rather than ships,
 * the chunks Turbopack emits.
 *
 * A patch names the kinds it has to reach, because a patch that reaches one of them and no longer
 * reaches another is the failure this is here to catch: `cache-signal-timers` is loaded from both the
 * source module and the compiled runtime, and a Function that got the first and missed the second is
 * a Function with the bug back. Counting files would say the same thing more brittlely — the number
 * of runtime variants is Next.js's to change — so what is declared is the kinds, not how many.
 *
 * `scripts/check-patches.ts` holds every patch to the kinds a published package can show. The one it
 * cannot show is `build-output`, and `tools/next-matrix` holds a patch to that by building an
 * application and reading what the adapter recorded. Pull-request CI runs the first and not the
 * second, so a rewrite that quietly stopped reaching one of its kinds would otherwise ship in a
 * Function and fail at the first request that needed it.
 */
export type Copy = 'build-output' | 'esm-module' | 'module' | 'server-runtime' | 'vendored';

export interface PatchContext {
  /** Absolute `.next` directory. */
  readonly distDir: string;
  /** Absolute paths of every server chunk the Turbopack runtime may load. */
  readonly chunks: readonly string[];
  /**
   * Those of them whose code is another's, each to the file that holds it (`same-chunks.ts`): the
   * chunk table loads that file in their place. A chunk not named here is loaded from its own.
   */
  readonly copies?: ReadonlyMap<string, string> | undefined;
  /** Absolute path of `.next/server/instrumentation.js`, when the app has a hook. */
  readonly instrumentation: string | undefined;
  /** The WebAssembly Turbopack's Node.js loader asks for, by the path it asks for it under. */
  readonly wasm: readonly { readonly chunkPath: string; readonly global: string }[];
}

export interface PatchResult {
  readonly contents: string;
  /** How many places were rewritten. */
  readonly edits: number;
  /** What the patch has to say about this file, for the dependency record. */
  readonly notes: readonly string[];
}

export interface Patch {
  readonly name: string;
  /** Matches the path of the file to rewrite, with `/` separators whatever the platform's. */
  readonly target: RegExp;
  /**
   * For a patch whose file has no name to match — Turbopack puts its WebAssembly loader in
   * whichever chunk first needed it — what in the source says this is the file. A file the
   * target matches and the marker does not is left alone and is not recorded; a file the marker
   * says yes to is held to the counts in `apply` like any other, so a marker has to be certain
   * rather than suggestive, and may have to ask more than one question: a customer whose own code
   * happens to carry one mark of Next.js's would otherwise get a build failure naming their
   * Next.js version.
   */
  readonly marker?: (source: string) => boolean;
  /**
   * The kinds of copy this has to reach, and what a checker holds it to. `Copy` says why the kinds are
   * what is declared rather than a count of files.
   *
   * One at least: a patch that reached nothing anywhere would otherwise be a patch nothing checks.
   */
  readonly reaches: readonly [Copy, ...Copy[]];
  apply(source: string, file: string, ctx: PatchContext): PatchResult;
}

/**
 * How many times `pattern` is in `contents`; a regular expression has to be global to be counted.
 * A global pattern carries a `lastIndex` from whatever looked at it last — a patch is applied to
 * every file that claims it — so the count always starts from the top.
 */
export function occurrencesOf(contents: string, pattern: string | RegExp): number {
  if (typeof pattern === 'string') {
    return contents.split(pattern).length - 1;
  }
  pattern.lastIndex = 0;
  return [...contents.matchAll(pattern)].length;
}

/**
 * A replacement that stands for itself. `String.replaceAll` reads `$&`, `` $` ``, `$'`, `$1` and
 * `$<name>` out of a replacement string, and a patch's replacement is usually built from
 * something this build was handed — an absolute path, a module name — where those mean nothing.
 * Returning it from a function would do as well, but that would cost the count `#rewrite` takes.
 */
function literally(replacement: string): (match: string) => string {
  return () => replacement;
}

export class PatchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PatchError';
  }
}

/** One file under rewrite: each step insists on what it found, and the result is read at the end. */
export class Rewrite {
  readonly #patch: string;
  readonly #file: string;
  readonly contents: string;
  readonly edits: number;

  constructor(patch: string, file: string, contents: string, edits = 0) {
    this.#patch = patch;
    this.#file = file;
    this.contents = contents;
    this.edits = edits;
  }

  /**
   * The count is taken before the replacement rather than during it: `String.replaceAll` takes a
   * function's return value verbatim, so counting inside one would rule out `$<name>` for good.
   */
  #rewrite(
    pattern: string | RegExp,
    replacement: string | ((match: string) => string),
    expected: number,
    what: string,
  ): Rewrite {
    const count = occurrencesOf(this.contents, pattern);
    if (count !== expected) {
      throw this.fail(`expected ${what} ${expected} time(s), found ${count}`);
    }
    const contents =
      typeof replacement === 'string'
        ? // eslint-disable-next-line unicorn/no-unsafe-string-replacement -- `expand` is the only caller, and that is what it promises
          this.contents.replaceAll(pattern, replacement)
        : this.contents.replaceAll(pattern, (match: string) => replacement(match));
    return new Rewrite(this.#patch, this.#file, contents, this.edits + count);
  }

  fail(detail: string): PatchError {
    return new PatchError(
      `@stayingupwind/adapter: ${this.#patch} could not patch ${this.#file}: ${detail}; this Next.js version is not supported`,
    );
  }

  /**
   * Replace every occurrence of `pattern`, and insist on how many there were. A string pattern
   * matches literally, and so does a string replacement: most of them are built from a path or a
   * module name this build was handed, and a `$&` or a `$'` that happens to be in one stands for
   * itself. For a replacement that means to name the match's groups, see `expand`.
   */
  replace(
    pattern: string | RegExp,
    replacement: string | ((match: string) => string),
    expected: number,
    what: string,
  ): Rewrite {
    return this.#rewrite(
      pattern,
      typeof replacement === 'string' ? literally(replacement) : replacement,
      expected,
      what,
    );
  }

  /**
   * Replace as `replace` does, with `$<name>` in `template` standing for that named group of the
   * match — a minified file names nothing the same way twice, so what a rewrite has to keep is
   * read off the match rather than written into it.
   */
  expand(pattern: RegExp, template: string, expected: number, what: string): Rewrite {
    return this.#rewrite(pattern, template, expected, what);
  }

  /** Fail if any of `patterns` (literal strings, or non-global regular expressions) survives. */
  forbid(patterns: readonly (string | RegExp)[], what: string): this {
    for (const pattern of patterns) {
      const present =
        typeof pattern === 'string' ? this.contents.includes(pattern) : pattern.test(this.contents);
      if (present) {
        throw this.fail(`${what} is still there after the rewrite (${String(pattern)})`);
      }
    }
    return this;
  }

  append(text: string): Rewrite {
    return new Rewrite(this.#patch, this.#file, this.contents + text, this.edits);
  }
}
