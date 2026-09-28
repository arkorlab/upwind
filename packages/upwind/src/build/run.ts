import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
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
 * With one exception, and it is about somebody else's build: on Vercel this command names nothing
 * (`isVercelsOwnBuild`). That is half of what a project deployed to both places needs; the other
 * half is its own `next.config`, which outranks this and is nothing this process can see.
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

/** What pnpm calls the reader's directory in a store, whoever in the tree depends on it. */
const READER_IN_STORE = '@stayingupwind+sdk@';

/**
 * Can anything in this project reach the reader?
 *
 * Resolution from the project answers for a project that depends on it, which is nearly all of them,
 * and under npm and Yarn it answers for one that reaches it through a package of its own as well,
 * since those hoist. pnpm does not hoist: a shared package that depends on the reader has it in a
 * store, reachable by the code that imports it and not from the application's own directory. So the
 * store is looked at too — from here upwards, because in a workspace it belongs to the repository
 * rather than to the project.
 *
 * Wrong in the harmless direction, if it is wrong: a store higher up that holds the reader for some
 * other project costs this one a runtime it does not use, which is what every build did before this
 * gate existed.
 */
function readsStorage(projectDir: string): boolean {
  if (resolveFromProject(projectDir, READER_PACKAGE) !== undefined) {
    return true;
  }
  let at = path.resolve(projectDir);
  for (;;) {
    try {
      const store = readdirSync(path.join(at, 'node_modules', '.pnpm'));
      if (store.some((entry) => entry.startsWith(READER_IN_STORE))) {
        return true;
      }
    } catch {
      // No store here, or none this may read. Either way the answer is not here.
    }
    const up = path.dirname(at);
    if (up === at) {
      return false;
    }
    at = up;
  }
}

/**
 * What the build is told about the project's storage, and nothing at all for a project that has no
 * way to read it.
 *
 * Storage costs a build something: a runtime process in the worker that renders, and — since a
 * directory of it belongs to one runtime — that worker being the only one, which the adapter arranges
 * from `UPWIND_LOCAL_RESOURCES`. Neither is worth a project that never asks for storage, and whether
 * it can ask is a question with an answer (`readsStorage`).
 */
function storageEnv(projectDir: string): Record<string, string> {
  if (!readsStorage(projectDir)) {
    return {};
  }
  return {
    [PROJECT_DIR_ENV]: projectDir,
    // Read by the adapter, in the child, while Next.js loads the config.
    [UPWIND_LOCAL_RESOURCES_ENV]: '1',
    NODE_OPTIONS: nodeOptionsWith(localResourcesEntry()),
  };
}

/**
 * A build on Vercel, where the one thing this command adds is the one thing not to do.
 *
 * Vercel sets `VERCEL` on every build it runs, and a build there is Vercel's. An adapter named in it
 * takes the deployment over: `next build` writes a bundle under `.ppr-cdn/`, which Vercel does not
 * read — and stops writing the file traces Vercel's own build does
 * (`next-server.js.nft.json`, `next-minimal-server.js.nft.json`, absent from `.next/` whenever an
 * adapter is named). So on Vercel this command is the project's own `next build` and nothing else:
 * no adapter, and no storage published for one (`storageEnv`).
 *
 * `NEXT_ADAPTER_PATH` still wins, for the build that means it. A job that runs on Vercel to produce
 * a bundle rather than a Vercel deployment names the adapter in the environment and gets one, which
 * is the same sentence this command has always honoured.
 */
function isVercelsOwnBuild(): boolean {
  const named = process.env[ADAPTER_PATH_ENV];
  if (named !== undefined && named !== '') {
    return false;
  }
  const vercel = process.env['VERCEL'];
  return vercel !== undefined && vercel !== '';
}

export async function runBuild(options: BuildOptions): Promise<never> {
  const vercel = isVercelsOwnBuild();
  if (vercel) {
    // Said rather than done quietly: what makes this command different from `next build` is the
    // adapter, and a run that names none has to be a run that says why. It says what *this* does and
    // no more — a `next.config` that names an adapter of its own is read later, by Next.js, and this
    // process cannot know what it will find there.
    console.log(
      'upwind: VERCEL is set, so this command names no adapter and publishes no storage — what runs is the project’s own `next build`. A `next.config` that names an adapter still names it; `NEXT_ADAPTER_PATH` names one for this build.',
    );
  }
  const adapter = vercel ? undefined : resolveAdapterPath(options.projectDir);
  if (!vercel && adapter === undefined) {
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
      // Both together, or neither: the storage a build publishes is published for the adapter to
      // bind, and a build with no adapter is one with nothing to bind it to.
      ...(adapter !== undefined && {
        [ADAPTER_PATH_ENV]: adapter,
        ...storageEnv(options.projectDir),
      }),
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
