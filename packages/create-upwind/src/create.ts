import path from 'node:path';

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
 * the first person cloned it.
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

/** A path a shell reads as one word, however the directories above it are spelled. */
function shellWord(value: string): string {
  if (/^[\w+,./:=@-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", () => ESCAPED_QUOTE)}'`;
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
  if (request.install) {
    console.log('');
    await install(manager, target);
  }
  const committed = request.git && (await initRepository(target));
  printNextSteps({ target, manager, committed, installed: request.install });
}
