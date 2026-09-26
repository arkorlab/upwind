import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * Which package manager scaffolded this, and the install it runs.
 *
 * `pnpm create upwind`, `npm create upwind`, `yarn create upwind` and `bun create upwind` all reach
 * this same program, and the one thing they leave behind to say which they were is
 * `npm_config_user_agent`. A project installed with the manager its author started from is one whose
 * lockfile is the one they expect.
 */

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** `pnpm/12.4.1 npm/? node/? linux x64` — the name is everything before the first slash. */
export function detectPackageManager(): PackageManager {
  const agent = process.env['npm_config_user_agent'] ?? '';
  const [name] = agent.split('/', 1);
  const known = PACKAGE_MANAGERS.find((manager) => manager === name);
  return known ?? 'npm';
}

/** The application is on disk by now, whatever went wrong here; say so, and say what to do. */
function refuse(manager: PackageManager, why: string): never {
  throw new Error(
    `${why}. The application is written; run \`${manager} install\` in it once you know why.`,
  );
}

export async function install(manager: PackageManager, cwd: string): Promise<void> {
  const child = spawn(manager, ['install'], {
    cwd,
    stdio: 'inherit',
    // Windows reaches `pnpm.cmd` and friends through the shell and not otherwise. The command is one
    // of four names of this program's own choosing, and nothing of the user's reaches the line.
    shell: process.platform === 'win32',
  });
  let code;
  try {
    [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  } catch {
    // `events.once` rejects on `error`, which is what a command that is not on the PATH raises — a
    // `--use-bun` on a machine with no bun. The raw `spawn bun ENOENT` says less than this does.
    refuse(manager, `\`${manager}\` could not be run; it may not be installed`);
  }
  if (code !== 0) {
    refuse(manager, `\`${manager} install\` failed`);
  }
}

/**
 * How a developer runs one of the project's scripts with this manager.
 *
 * `npm` is the one that needs `run`: `npm dev` is not a command, while `pnpm dev`, `yarn dev` and
 * `bun dev` all are. A next step somebody cannot paste is not a next step.
 */
export function runCommand(manager: PackageManager, script: string): string {
  return manager === 'npm' ? `npm run ${script}` : `${manager} ${script}`;
}
