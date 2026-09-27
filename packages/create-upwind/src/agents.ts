import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * What a scaffolded project tells a coding agent, which is what Next.js tells one.
 *
 * Both files below are Next.js's own, verbatim. The block is `buildAgentRulesBlock()` in
 * `next/dist/server/lib/generate-agent-files.js`, and writing the pair is what `create-next-app`
 * does (`helpers/generate-agent-files.ts`) for every project it makes. Next.js is MIT-licensed,
 * Copyright (c) 2025 Vercel, Inc.; the attribution is in this package's `NOTICE` and the licence
 * text in `LICENSE-MIT`, both of which ship with it.
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
  '# This is NOT the Next.js you know',
  '',
  "This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.",
  '',
  'This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.',
  '',
  '<!-- END:nextjs-agent-rules -->',
  '',
].join('\n');

/**
 * `CLAUDE.md`, whole: an import of the file beside it.
 *
 * Claude Code reads `CLAUDE.md` and other agents read `AGENTS.md`, and one set of rules in two
 * files is one that is edited in one of them. `@AGENTS.md` is the import, so there is one file to
 * edit and the other points at it.
 */
const CLAUDE_MD = '@AGENTS.md\n';

export async function writeAgentRules(target: string): Promise<void> {
  await writeFile(path.join(target, 'AGENTS.md'), AGENTS_MD);
  await writeFile(path.join(target, 'CLAUDE.md'), CLAUDE_MD);
}
