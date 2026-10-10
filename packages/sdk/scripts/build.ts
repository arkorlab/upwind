import { spawnSync } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

/**
 * The package as an application reads it: JavaScript, and declarations beside it.
 *
 * Unlike the other packages here, this one is imported by *application* code, which means a bundler
 * that was given the application — Turbopack, and then the adapter's — is what reads it. Those do not
 * compile TypeScript out of `node_modules`, so `exports` names `dist` and `dist` is built here, in
 * both halves:
 *
 * - **the modules**, one per entry point, with `@stayingupwind/core` bundled in. Core is published as
 *   the TypeScript it is, so an installed copy of this package could not import it at runtime — the
 *   same reason the CLI bundles it. What is taken from it is two constants: the symbol key and the
 *   version. They are taken rather than written out again because they are the contract, and a copy
 *   of a contract is a copy that goes stale without saying so.
 * - **the declarations**, from `tsc`, which is also what holds this package's public types to being
 *   its own and Cloudflare's — a declaration that reached into core would make every application
 *   compile core's sources, with the `tsconfig` that needs.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'dist');

/** The entry points `exports` names, and the only names `dist` is entered through. */
const ENTRIES = ['index', 'db', 'kv', 'blob', 'durable-object'] as const;

async function modules(): Promise<number> {
  const build = await rolldown({
    input: Object.fromEntries(ENTRIES.map((name) => [name, path.join(ROOT, `src/${name}.ts`)])),
    // Neither Node nor a browser: this runs wherever the application does, which is a Function as
    // often as it is a development server.
    platform: 'neutral',
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
 * The sources name each other by the files they are — `./named.ts`, as everything in this repository
 * does — and `tsc` emits a specifier exactly as it was written: `rewriteRelativeImportExtensions`
 * rewrites the JavaScript it emits and deliberately not these. Left alone, an application reading
 * these types would have to allow importing `.ts` paths to read them at all, which is precisely the
 * kind of thing a package has no business asking of the projects that install it.
 *
 * Rewritten, each names a sibling `.js` and resolves to the `.d.ts` beside it, which is the ordinary
 * shape of a published package and asks nothing of anybody's `tsconfig`. No such `.js` is emitted, and
 * none is needed: what runs is the bundle, whose imports are its own chunks.
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
