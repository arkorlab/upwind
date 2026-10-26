import path from 'node:path';

import { refreshAgentRules, writeAgentRules } from './agents.ts';
import type { CreateRequest } from './args.ts';
import { initRepository } from './git.ts';
import { writeManifest } from './manifest.ts';
import { nameProblem } from './name.ts';
import {
  detectPackageManager,
  install,
  type PackageManager,
  runCommand,
} from './package-manager.ts';
import { askDirectory } from './prompt.ts';
import { conflictsIn, copyTemplate, retellReadme } from './template.ts';

/**
 * One run: a directory with a Next.js application in it that upwind can run.
 *
 * The order is the order a developer would do it in. Everything that can be refused is refused
 * before anything is written — a name npm would not take, a directory with something in it — so a
 * run either leaves an application or leaves nothing.
 *
 * The install comes before the first commit so the lockfile is in it: the point of a lockfile is the
 * install somebody else does from it, and one that arrives a commit late is one that arrives after
 * the first person cloned it. The agent rules are between the two for the same reason and the other
 * way round — written from what this release knows, corrected by the Next.js that actually arrived,
 * and only then committed.
 */

const DEFAULT_DIRECTORY = 'my-upwind-app';
/** How many of the things in the way to name before saying "and others". */
const CONFLICTS_SHOWN = 5;

function refuseConflicts(target: string, conflicts: readonly string[]): never {
  const shown = conflicts.slice(0, CONFLICTS_SHOWN).join(', ');
  const rest =
    conflicts.length > CONFLICTS_SHOWN ? `, and ${conflicts.length - CONFLICTS_SHOWN} more` : '';
  throw new Error(`${target} already has something in it (${shown}${rest})`);
}

/** The POSIX word formatter keeps paths beginning with a dash out of option parsing. */
const ESCAPED_QUOTE = String.raw`'\''`;
const PLAIN = /^[\w+,./:=@-]+$/u;

/** Windows next steps explicitly target PowerShell, including its smart single-quote delimiters. */
export function directoryCommand(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const literal = value.replaceAll(/['\u{2018}-\u{201B}]/gu, (quote) => quote + quote);
    return `Set-Location -LiteralPath '${literal}'`;
  }
  const safe = value.startsWith('-') ? `./${value}` : value;
  const word = PLAIN.test(safe) ? safe : `'${safe.replaceAll("'", () => ESCAPED_QUOTE)}'`;
  return `cd ${word}`;
}

function printNextSteps(options: {
  readonly target: string;
  readonly manager: PackageManager;
  readonly committed: boolean;
  readonly installed: boolean;
}): void {
  const { manager, target } = options;
  const where = path.relative(process.cwd(), target);
  const dev = runCommand(manager, 'dev');
  console.log('');
  console.log(
    `Created ${path.basename(target)}${options.committed ? ' with a first commit' : ''}.`,
  );
  console.log('');
  if (where !== '') {
    if (process.platform === 'win32') console.log('  # PowerShell');
    console.log(`  ${directoryCommand(where)}`);
  }
  if (!options.installed) {
    // Nothing was installed, so `dev` would be a command that is not there yet.
    console.log(`  ${manager} install`);
  }
  console.log(`  ${dev}`);
  console.log('');
  console.log(
    `\`${dev}\` runs upwind in front of the project's own Next.js, and /__upwind is answered by`,
  );
  console.log(
    `upwind itself. \`${runCommand(manager, 'build')}\` writes the deployment bundle under .arkor/.`,
  );
}

export async function create(request: CreateRequest): Promise<void> {
  const directory = request.directory ?? (await askDirectory(DEFAULT_DIRECTORY));
  const target = path.resolve(directory);
  const name = path.basename(target);
  const problem = nameProblem(name);
  if (problem !== undefined) {
    throw new Error(`\`${name}\` ${problem}`);
  }
  const conflicts = await conflictsIn(target);
  if (conflicts.length > 0) {
    refuseConflicts(target, conflicts);
  }
  const manager = request.packageManager ?? detectPackageManager();
  console.log(`Creating ${name} in ${target}`);
  await copyTemplate(target);
  await retellReadme(target, manager);
  await writeManifest(target, name);
  if (request.agentsMd) {
    await writeAgentRules(target);
  }
  if (request.install) {
    console.log('');
    await install(manager, target);
    if (request.agentsMd) {
      // The Next.js that just arrived may word its agent rules differently from the one this release
      // was built against, and it is the one the project will run (`agents.ts`).
      const asked = await refreshAgentRules(target);
      if (!asked) {
        // Said rather than swallowed, because the commonest reason is a whole package manager — a
        // Yarn Plug'n'Play install keeps its packages zipped where this process cannot read them —
        // and a scaffolder that quietly kept its own copy of somebody else's text would be found
        // out by a diff, months later, in a project nobody had touched.
        console.log('');
        console.log(
          "AGENTS.md holds create-upwind's own copy of Next.js's agent rules: this project's",
        );
        console.log(
          'Next.js could not be reached to write its own. The first `upwind dev` a coding agent runs',
        );
        console.log('brings it up to date.');
      }
    }
  }
  const committed = request.git && (await initRepository(target));
  printNextSteps({ target, manager, committed, installed: request.install });
}
