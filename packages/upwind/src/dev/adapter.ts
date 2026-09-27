import { type RestoreEnv, setEnv } from './env.ts';
import { resolveFromProject } from './next-app.ts';

/**
 * The adapter, named for this run.
 *
 * `next build` and the dev server load the same adapter module, and its `modifyConfig` runs in every
 * phase — which is how `/__upwind` comes to be reserved inside the dev server's own routing table
 * (see `dev-prefix.ts` in `@stayingupwind/adapter`). So `upwind dev` names it, from the project's own
 * installed copy, rather than asking every project to write it into `next.config` twice.
 *
 * Nothing is overwritten: a project's `next.config` that sets `adapterPath` wins over this
 * environment variable by Next.js's own precedence, and an environment that already names one is
 * left exactly as it is.
 *
 * And nothing is left behind: `restore` puts the environment back once Next.js has read it, for the
 * reasons `env.ts` gives.
 */

/** What Next.js's default config reads an adapter module's path from (`config-shared.ts`). */
const ADAPTER_PATH_ENV = 'NEXT_ADAPTER_PATH';
const ADAPTER_PACKAGE = '@stayingupwind/adapter';

export interface InstalledAdapter {
  /** The adapter module named for this run, or nothing when none was found. */
  readonly path: string | undefined;
  /** Put the environment back as it was, once the config that needed it has been read. */
  readonly restore: RestoreEnv;
}

/** For a run that set nothing: there is nothing to put back. */
function restoreNothing(): void {
  // The environment was not touched.
}

export function installAdapterPath(projectDir: string): InstalledAdapter {
  const configured = process.env[ADAPTER_PATH_ENV];
  if (configured !== undefined && configured !== '') {
    return { path: configured, restore: restoreNothing };
  }
  const resolved = resolveFromProject(projectDir, ADAPTER_PACKAGE);
  if (resolved === undefined) {
    console.warn(
      `upwind: ${ADAPTER_PACKAGE} is not installed in this project, so nothing reserves /__upwind inside Next.js's own routing — this server still answers it first`,
    );
    return { path: undefined, restore: restoreNothing };
  }
  return { path: resolved, restore: setEnv(ADAPTER_PATH_ENV, resolved) };
}
