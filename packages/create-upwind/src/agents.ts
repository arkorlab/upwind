import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * What a scaffolded project tells a coding agent, which is what Next.js tells one.
 *
 * The file below is Next.js's own, verbatim. The block is `buildAgentRulesBlock()` in
 * `next/dist/server/lib/generate-agent-files.js`, and writing it as `AGENTS.md` is what
 * `create-next-app` does (`helpers/generate-agent-files.ts`) for every project it makes. Next.js is
 * MIT-licensed, Copyright (c) 2025 Vercel, Inc.; the attribution is in this package's `NOTICE` and
 * the licence text in `LICENSE-MIT`, both of which ship with it.
 *
 * Until 16.4 there were two files: `AGENTS.md`, and a `CLAUDE.md` beside it that imported it
 * (`@AGENTS.md`). 16.4 writes `AGENTS.md` alone, from `create-next-app` and from `next dev` both,
 * and so does this.
 *
 * **Not a word of this may change.** `hasCurrentAgentRules()` compares the block a project holds
 * against the one Next.js would write — byte for byte, once line endings are normalised — and
 * `next dev` rewrites a block that does not match. A sentence improved here would be an
 * uncommitted change in the tree of everyone who runs `next dev` directly, which a project this
 * writes supports on purpose: `next.config.ts` names the adapter so that Next.js's own commands
 * do the same thing upwind's do.
 *
 * Which is why the block goes on saying it is "written and re-added by `next dev`" when, in a
 * project run by `upwind dev`, it is `upwind dev` that re-adds it (`upwind`'s
 * `src/dev/agent-rules.ts`, which asks the project's own Next.js to do the writing). Correcting
 * that sentence would cost exactly the byte equality the sentence is about.
 *
 * And for the same reason the scaffolded project carries no notice of its own. A byte added to
 * `AGENTS.md` is the byte equality above, broken, and a `NOTICE` file beside it is a file nobody
 * asked this to write into their application — `create-next-app`, which is Vercel's own and writes
 * this same text, writes neither. The notice this text needs is this package's, which is where a
 * copy of the text actually lives and is distributed from.
 */

/**
 * `AGENTS.md`, whole. The empty last element is the trailing newline Next.js writes.
 *
 * A list of lines rather than a template literal because the text is full of backticks, and a
 * version of it escaped for JavaScript is a version nobody can compare against the original by
 * eye — which is the one thing anybody will ever need to do to it.
 */
const AGENTS_MD = [
  '<!-- BEGIN:nextjs-agent-rules -->',
  '',
  '## This is NOT the Next.js you know',
  '',
  "This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.",
  '',
  'This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.',
  '',
  '<!-- END:nextjs-agent-rules -->',
  '',
].join('\n');

export async function writeAgentRules(target: string): Promise<void> {
  await writeFile(path.join(target, 'AGENTS.md'), AGENTS_MD);
}

/**
 * Hand the block over to the Next.js the install actually brought, and let it have the last word.
 *
 * The text above is the one this release was built against, and the manifest asks for `^16.4.0` —
 * so a project made once a later 16 is out installs a Next.js this scaffolder has never seen. If
 * that release words the block differently, everything written above is last version's wording, and
 * the project's first `next dev` rewrites a file that was committed a minute earlier. Which is
 * the drift this whole change exists to prevent, arriving by the one door the repository's own check
 * cannot watch: it holds this text to the Next.js in *this* checkout, and can say nothing about the
 * one a user will install months from now.
 *
 * So the static text is what a project starts with, and this is what corrects it. `writeAgentFiles`
 * replaces the block in place and leaves everything around it, so a project whose Next.js agrees is
 * not written to at all. Called after the install and before the first commit, so that a correction
 * is in the first commit rather than arriving as a change to it.
 *
 * Resolved from the project and called through, the same way `upwind`'s `src/dev/agent-rules.ts`
 * does it at dev time — duplicated deliberately: the two live in different packages, neither depends
 * on the other, and sharing thirty lines would mean one of them reaching across the workspace.
 *
 * There is one layout this cannot read, and it is a supported one. A Yarn Plug'n'Play install writes
 * no `node_modules` at all: packages stay zipped in Yarn's cache, reachable only through the runtime
 * `.pnp.cjs` sets up, and this scaffolder is a plain Node process that spawned `yarn install` as a
 * child rather than running under it. So `createRequire().resolve()` answers `MODULE_NOT_FOUND`, and
 * even resolving through `.pnp.cjs` by hand would hand back a path inside a zip that plain `fs`
 * cannot open. Reaching it would mean running this through the project's own manager — `yarn node` —
 * which is a child process and a script to quote, for a correction that is a no-op in every release
 * where the block has not changed. It is not done, and it is not hidden either: `asked` is false and
 * the caller says so.
 *
 * `upwind dev` is under no such handicap, because `yarn dev` runs it *inside* the runtime — resolution
 * and the dynamic `import` both work there — so a Yarn project is corrected on its first dev run
 * instead of at its first commit.
 *
 * Never fatal. `--skip-install` leaves nothing to ask, an older Next.js may not have the module, and
 * a project that starts with this release's wording is a long way from a project with none.
 *
 * @returns whether the project's own Next.js was reached and given the last word.
 */
export async function refreshAgentRules(target: string): Promise<boolean> {
  try {
    const entry = createRequire(path.join(target, 'package.json')).resolve(
      'next/dist/server/lib/generate-agent-files.js',
    );
    const module = (await import(pathToFileURL(entry).href)) as Record<string, unknown> & {
      default?: Record<string, unknown>;
    };
    // Both shapes, because Node's lexer reads the names out of some CommonJS modules and not others,
    // and the one it cannot read arrives with all of `module.exports` under `default`. Given a
    // signature on the way out, since what comes back from a `find` over `unknown` is only a
    // `Function`, and calling one of those is a call nothing has checked.
    const write = [module['writeAgentFiles'], module.default?.['writeAgentFiles']].find(
      (value) => typeof value === 'function',
    ) as ((dir: string) => unknown) | undefined;
    if (write === undefined) {
      return false;
    }
    // Awaited, though today's writes it synchronously and returns a plain object: a version that
    // returned a promise instead would otherwise have the first commit racing the write, and would
    // reject somewhere no `catch` of this one's could reach.
    await write(target);
    return true;
  } catch {
    // Nothing resolvable, nothing readable, nothing writable: the files written above stand.
    return false;
  }
}
