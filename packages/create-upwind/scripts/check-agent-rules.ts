import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { writeAgentFiles } from 'next/dist/server/lib/generate-agent-files.js';

import { writeAgentRules } from '../src/agents.ts';

/**
 * Holds `src/agents.ts` to Next.js's own words.
 *
 * What this package writes into `AGENTS.md` and `CLAUDE.md` is Next.js's text, and it is only worth
 * anything while it is *still* Next.js's text: `hasCurrentAgentRules()` compares a project's block
 * against the one the installed Next.js would write, byte for byte, and `next dev` rewrites a block
 * that does not match. A scaffolder shipping last release's wording would hand every new project an
 * uncommitted change, on the first `next dev` anybody ran in it.
 *
 * So the comparison is made against Next.js rather than asserted here: both sides write into an
 * empty directory of their own — which is the branch of `writeAgentFiles` that scaffolds both files,
 * the one `create-next-app` takes — and the bytes are compared. No network and no build; the Next.js
 * it checks against is the one in `node_modules`, the catalog pin, which is what `pnpm check:patches`
 * reads too.
 *
 * A failure here is not a bug in this repository. It is Next.js having changed the block, and the
 * fix is to copy the new one into `src/agents.ts` — from `buildAgentRulesBlock()` in the file named
 * below, which is where the text printed by the failure came from.
 */

/** The two files, in the order a reader of the failure would want them. */
const FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

/**
 * Next.js's own writer, loaded from the installed package.
 *
 * `require` rather than `import`: it is CommonJS in a package with no export map, and this wants the
 * function itself rather than whichever shape Node's lexer decides to hand an ESM importer. The type
 * comes from the same path, so a release that moves or renames it fails `pnpm typecheck` here rather
 * than at the first mismatch.
 */
function nextWriter(): typeof writeAgentFiles {
  const require = createRequire(import.meta.url);
  const module = require('next/dist/server/lib/generate-agent-files.js') as {
    writeAgentFiles: typeof writeAgentFiles;
  };
  return module.writeAgentFiles;
}

/** Where the two disagree, in the terms somebody fixing it would use: a line, and both versions of it. */
function firstDifference(ours: Buffer, theirs: Buffer): string {
  const mine = ours.toString('utf8').split('\n');
  const yours = theirs.toString('utf8').split('\n');
  for (let line = 0; line < Math.max(mine.length, yours.length); line += 1) {
    if (mine[line] !== yours[line]) {
      return [
        `  line ${String(line + 1)}`,
        `    create-upwind: ${JSON.stringify(mine[line])}`,
        `    Next.js:       ${JSON.stringify(yours[line])}`,
      ].join('\n');
    }
  }
  // Same lines, different bytes: something that survives `split` and does not survive a decode.
  return `  the same text in different bytes (${String(ours.length)} against ${String(theirs.length)})`;
}

async function main(): Promise<void> {
  const writeNext = nextWriter();
  const ours = await mkdtemp(path.join(tmpdir(), 'create-upwind-agents-'));
  const theirs = await mkdtemp(path.join(tmpdir(), 'next-agents-'));
  try {
    await writeAgentRules(ours);
    writeNext(theirs);
    const differences: string[] = [];
    for (const file of FILES) {
      const mine = await readFile(path.join(ours, file));
      const yours = await readFile(path.join(theirs, file));
      if (!mine.equals(yours)) {
        differences.push(`${file}:\n${firstDifference(mine, yours)}`);
      }
    }
    if (differences.length > 0) {
      throw new Error(
        [
          'what create-upwind writes is no longer what Next.js writes:',
          '',
          ...differences,
          '',
          'Copy the current text out of `buildAgentRulesBlock()` in',
          '`next/dist/server/lib/generate-agent-files.js` into `packages/create-upwind/src/agents.ts`.',
        ].join('\n'),
      );
    }
    console.log(`agent rules: ${FILES.join(' and ')} are Next.js's own, byte for byte`);
  } finally {
    // Both, whatever happened: a failing check that leaves two directories in `/tmp` per run is a
    // check somebody turns off.
    await rm(ours, { recursive: true, force: true });
    await rm(theirs, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? `check-agent-rules: ${error.message}` : error);
  process.exitCode = 1;
}
