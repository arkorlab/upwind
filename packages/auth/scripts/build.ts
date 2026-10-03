import { spawnSync } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

/**
 * The package as an application reads it: JavaScript, and declarations beside it.
 *
 * The same arrangement as `@stayingupwind/sdk`, and for the same reason — this is imported by
 * *application* code, so what reads it is Turbopack and then the adapter's bundler, neither of which
 * compiles TypeScript out of `node_modules`. `exports` names `dist`, and `dist` is built here in two
 * halves: the modules, and the declarations `tsc` emits beside them.
 *
 * What is bundled in and what is left out is the one decision this makes:
 *
 * - **`@stayingupwind/core` is bundled.** It is published as the TypeScript it is, so an installed
 *   copy of this package could not import it at runtime. What is taken from it is the base path and
 *   the name of the generated secret's variable — the contract this package shares with the CLI and
 *   the adapter, taken rather than copied so that a copy cannot go stale quietly.
 * - **everything else is left alone.** `better-auth` and `next` are peer dependencies and
 *   `@stayingupwind/sdk` is a real one: a project has exactly one copy of each, and a copy bundled
 *   in here would be a second — which for Better Auth means two module graphs, two sets of plugin
 *   identities, and types that describe neither.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'dist');

/** The entry points `exports` names, and the only names `dist` is entered through. */
const ENTRIES = ['index', 'next', 'client'] as const;

/** The one package that is bundled rather than resolved from wherever this was installed. */
const BUNDLED = '@stayingupwind/core';

/** Is this specifier one of this package's own files, or the one package bundled with them? */
function isOwn(specifier: string): boolean {
  return (
    specifier.startsWith('.') ||
    specifier === BUNDLED ||
    specifier.startsWith(`${BUNDLED}/`) ||
    path.isAbsolute(specifier)
  );
}

async function modules(): Promise<number> {
  const build = await rolldown({
    input: Object.fromEntries(ENTRIES.map((name) => [name, path.join(ROOT, `src/${name}.ts`)])),
    // Neither Node nor a browser: this runs wherever the application does, which is a Function as
    // often as it is a development server.
    platform: 'neutral',
    external: (specifier) => !isOwn(specifier),
  });
  const { output } = await build.write({
    dir: OUT_DIR,
    format: 'esm',
    entryFileNames: '[name].js',
    chunkFileNames: '[name]-[hash].js',
  });
  await build.close();
  return output.length;
}

function declarations(): void {
  // The `tsc` this package was installed beside, rather than one from a PATH that may hold another.
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const emit = spawnSync(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.build.json')], {
    stdio: 'inherit',
  });
  if (emit.status !== 0) {
    // `status` is `null` for a `tsc` that never started or that a signal ended, and then what went
    // wrong is on the result rather than on the terminal.
    const why = emit.error?.message ?? emit.signal ?? `exit ${String(emit.status)}`;
    throw new Error(`the declarations did not build (${why})`);
  }
}

/** A line that imports or exports: the only place a specifier stands in a declaration file. */
const STATEMENT_LINE = /^\s*(?:import|export)\b/u;

/** A line of prose — a comment — which is the one place a `.ts` may still be named afterwards. */
const PROSE_LINE = /^\s*(?:\/\*|\*|\/\/)/u;

/** One line, with any specifier on it pointed at JavaScript. A quote is the end of a specifier. */
function pointedLine(line: string): string {
  return STATEMENT_LINE.test(line)
    ? line.replaceAll(".ts'", ".js'").replaceAll('.ts"', '.js"')
    : line;
}

/**
 * Point the declarations at JavaScript rather than at the TypeScript they were written from.
 *
 * The same pass `@stayingupwind/sdk` runs, for the same reason: the sources name each other by the
 * files they are, `tsc` emits a specifier exactly as it was written, and an application reading
 * these types would otherwise have to allow importing `.ts` paths to read them at all.
 */
async function pointAtJavaScript(): Promise<void> {
  const emitted = (await readdir(OUT_DIR)).filter((name) => name.endsWith('.d.ts'));
  for (const name of emitted) {
    const at = path.join(OUT_DIR, name);
    const declared = await readFile(at, 'utf8');
    const lines = declared.split('\n').map((line) => pointedLine(line));
    // Whatever the rewrite did not reach, nothing downstream will either. A form this pass does not
    // know — a specifier inside a type, from a file written later — fails the build rather than
    // shipping declarations only some projects can read.
    const missed = lines.find((line) => !PROSE_LINE.test(line) && line.includes('.ts'));
    if (missed !== undefined) {
      throw new Error(`dist/${name} still points at TypeScript: ${missed.trim()}`);
    }
    const pointed = lines.join('\n');
    if (pointed !== declared) {
      await writeFile(at, pointed);
    }
  }
}

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  const chunks = await modules();
  declarations();
  await pointAtJavaScript();
  console.log(`dist/: ${String(ENTRIES.length)} entry point(s), ${String(chunks)} chunk(s)`);
}

await main();
