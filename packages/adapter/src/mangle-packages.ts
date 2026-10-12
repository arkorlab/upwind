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
 * Only CommonJS. An ES module is hoisted into the bundle, where what it does not use is shaken out
 * by its `@__PURE__` annotations, and renaming prints it without them.
 *
 * A module that does not come out smaller is left as it was: a package that ships minified code,
 * whose names would only grow. Nothing renamed is a name a stack trace prints — a function's or a
 * class's, or one a frame takes from the binding it was assigned to — nor one another module reads,
 * since a CommonJS module is wrapped in a function of its own and read through its `exports`. The
 * module's map is handed on, for whatever map the bundle is written with.
 */

/** A package's file, by its path: what the build installed rather than what it wrote. */
const PACKAGE_FILE = /[/\\]node_modules[/\\].+\.c?js$/u;
/** Minified by Next.js's own build, the page runtime among them: see above. */
const PRECOMPILED = /[/\\]node_modules[/\\]next[/\\]dist[/\\]compiled[/\\]/u;

/** As each module is printed, renamed or not, to tell which is the smaller. */
const PRINTED = { module: false, compress: false, codegen: { removeWhitespace: true } } as const;

/** The module renamed, with its map; `undefined` where it is not CommonJS or comes out no smaller. */
function renamed(
  id: string,
  code: string,
): { code: string; map: ExistingRawSourceMap } | undefined {
  const parsed = parseSync(id, code, { sourceType: 'unambiguous' });
  if (parsed.errors.length > 0 || parsed.module.hasModuleSyntax) {
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
  return kept.errors.length === 0 && mangled.code.length < kept.code.length
    ? { code: mangled.code, map: mangled.map }
    : undefined;
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
