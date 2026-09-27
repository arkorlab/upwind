import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { UPWIND_LOCAL_RESOURCES_ENV } from '@stayingupwind/core/paas';

import { ADAPTER_PACKAGE, ADAPTER_PATH_ENV, resolveAdapterPath } from '../dev/adapter.ts';
import { resolveFromProject } from '../dev/next-app.ts';
import { localResourcesEntry, PROJECT_DIR_ENV } from '../resources/entry-path.ts';
import type { BuildOptions } from './args.ts';

/**
 * `upwind build` — the project's own `next build`, with the adapter named.
 *
 * That is the whole of it. The bundle is the adapter's work and the build is Next.js's; what was
 * missing was only the one thing `upwind dev` already does, which is to say *which* adapter, from the
 * project rather than from wherever this CLI is installed.
 *
 * A child process rather than an import, because `next build` is a program: it decides `NODE_ENV`,
 * runs workers, prints for a terminal and ends the process itself. Wrapping it means running it, and
 * this run ends the way that one did.
 */

/** Where the project's own Next.js keeps its command, as its own manifest declares it. */
async function nextCommand(projectDir: string): Promise<string> {
  const manifestPath = resolveFromProject(projectDir, 'next/package.json');
  if (manifestPath === undefined) {
    throw new Error(
      `no \`next\` is installed in ${projectDir} — \`upwind build\` builds the project's own Next.js, so install it there first`,
    );
  }
  // `bin` rather than a path into `next/dist`: the package says where its command is, and a release
  // that moves it says so there.
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['next'];
  if (bin === undefined) {
    throw new Error(`the \`next\` installed in ${projectDir} declares no \`next\` command`);
  }
  return path.join(path.dirname(manifestPath), bin);
}

/**
 * `NODE_OPTIONS` for the build: whatever the environment already asked for, and then the publisher.
 *
 * Appended rather than assigned. A project that runs its builds with `--max-old-space-size` or a
 * loader of its own said so on purpose, and a build that silently dropped it would fail in a way
 * that looks nothing like this line.
 */
function nodeOptionsWith(imported: string): string {
  const asked = process.env['NODE_OPTIONS']?.trim();
  const ours = `--import ${imported}`;
  return asked === undefined || asked === '' ? ours : `${asked} ${ours}`;
}

/** What an application reads its storage through. A project without it cannot ask for any. */
const READER_PACKAGE = '@stayingupwind/sdk';

/**
 * What the build is told about the project's storage, and nothing at all for a project that has no
 * way to read it.
 *
 * Storage costs a build something: a runtime process in the worker that renders, and — since a
 * directory of it belongs to one runtime — that worker being the only one, which the adapter arranges
 * from `UPWIND_LOCAL_RESOURCES`. Neither is worth a project that never asks for storage, and whether
 * it can ask is a question with an answer: is the reader installed.
 *
 * A project that reaches the reader only through a package of its own, and does not depend on it
 * itself, is the one case this answers wrongly. Its build gets no storage, and the reader says so at
 * the line that wanted some.
 */
function storageEnv(projectDir: string): Record<string, string> {
  if (resolveFromProject(projectDir, READER_PACKAGE) === undefined) {
    return {};
  }
  return {
    [PROJECT_DIR_ENV]: projectDir,
    // Read by the adapter, in the child, while Next.js loads the config.
    [UPWIND_LOCAL_RESOURCES_ENV]: '1',
    NODE_OPTIONS: nodeOptionsWith(localResourcesEntry()),
  };
}

export async function runBuild(options: BuildOptions): Promise<never> {
  const adapter = resolveAdapterPath(options.projectDir);
  if (adapter === undefined) {
    // Refused rather than warned about: a build without the adapter is a build that runs to the end
    // and produces no deployment bundle, which is the one thing this command is for.
    throw new Error(
      `${ADAPTER_PACKAGE} is not installed in ${options.projectDir}, and without it a build produces no deployment bundle — install it, or run \`next build\` if that is what you meant`,
    );
  }
  const command = await nextCommand(options.projectDir);
  // The same Node that is running this, so the command is reached without a shebang, a PATH lookup or
  // a shell.
  //
  // The adapter goes in the environment the child inherits, where Next.js reads it as the default for
  // `adapterPath`. A `next.config` that names one of its own still wins, by Next.js's own precedence.
  // What this does *not* see is a `.env` file: Next.js loads those itself, inside the child, and
  // leaves a variable the process already has alone — so an adapter named in `.env` is one this run
  // overrides. Name it in `next.config` or in the environment, which are the two places that win.
  //
  // The project's storage goes in the same environment, as an import every process of the build runs
  // before anything else: this process cannot publish it for them, and the one that renders pages is
  // where an application asks for it (`storageEnv`, `resources/entry.ts`).
  const child = spawn(process.execPath, [command, 'build', options.projectDir], {
    cwd: options.projectDir,
    env: {
      ...process.env,
      [ADAPTER_PATH_ENV]: adapter,
      ...storageEnv(options.projectDir),
    },
    stdio: 'inherit',
  });
  // A signal this process is sent is the build's too. Without this, a `kill` on `upwind build` would
  // leave `next build` running — writing into `.next` and `.ppr-cdn` with nothing left waiting for
  // it. The terminal's own Ctrl-C reaches both anyway; this is for everything else.
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  const onInterrupt = (): void => {
    forward('SIGINT');
  };
  const onTerminate = (): void => {
    forward('SIGTERM');
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    // `events.once` rejects if the child emits `error` instead: a command that never started is a
    // failure of this one.
    const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    // A build that ended on a signal chose no code of its own, and produced nothing: a failure.
    process.exit(code ?? 1);
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}
