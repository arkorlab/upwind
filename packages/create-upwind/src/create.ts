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

/** How a single quote is written inside single quotes: close, escape one, open again. */
const ESCAPED_QUOTE = String.raw`'\''`;
/** What needs no quoting anywhere, plus the separator each shell writes a path with. */
const PLAIN = process.platform === 'win32' ? /^[\w+,.:=@\\-]+$/u : /^[\w+,./:=@-]+$/u;

/**
 * A path the shell this was run from reads as one word, and as a path.
 *
 * Two things can go wrong with a next step somebody pastes. A path with a space in it is two
 * arguments — and `cmd.exe` does not read the single quotes a POSIX shell does, so the quoting has
 * to be the one the platform uses. And a relative path that begins with `-` is read as options by
 * every shell there is, which `./` settles.
 *
 * Two things are left, and both are `cmd.exe`'s alone. It expands `%NAME%` inside double quotes and
 * has no escape for it at the prompt, so a directory with a percent sign in its name prints a line
 * that reads as something else there. And a target on another drive needs `cd /d` there, which is
 * not a `cd` PowerShell accepts. Both read correctly in PowerShell, which is where a Windows
 * developer is more likely to be standing, and the alternative would be a line that is wrong in the
 * other shell instead.
 */
function shellWord(value: string): string {
  const safe = value.startsWith('-') ? `./${value}` : value;
  if (PLAIN.test(safe)) {
    return safe;
  }
  return process.platform === 'win32'
    ? `"${safe}"`
    : `'${safe.replaceAll("'", () => ESCAPED_QUOTE)}'`;
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
    console.log(`  cd ${shellWord(where)}`);
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
    `upwind itself. \`${runCommand(manager, 'build')}\` writes the deployment bundle under .ppr-cdn/.`,
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
      await refreshAgentRules(target);
    }
  }
  const committed = request.git && (await initRepository(target));
  printNextSteps({ target, manager, committed, installed: request.install });
}
