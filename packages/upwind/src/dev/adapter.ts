import { resolveFromProject } from './next-app.ts';

/**
 * The adapter, named for a run.
 *
 * `next build` and the dev server load the same adapter module, and its `modifyConfig` runs in every
 * phase — which is how `/__upwind` comes to be reserved inside the dev server's own routing table
 * (see `dev-prefix.ts` in `@stayingupwind/adapter`). So `upwind` names it, from the project's own
 * installed copy, rather than asking every project to write it into `next.config` twice.
 *
 * Nothing is overwritten: a project's `next.config` that sets `adapterPath` wins over this
 * environment variable by Next.js's own precedence, and an environment that already names one is left
 * exactly as it is.
 *
 * Both commands come through here, and they differ in what a missing adapter means. A dev server
 * without one still serves the application and still answers `/__upwind` at the front door, so it
 * says what is lost and carries on. A build without one produces no deployment bundle at all, so
 * `upwind build` refuses (`build/run.ts`).
 */

/** What Next.js's default config reads an adapter module's path from (`config-shared.ts`). */
export const ADAPTER_PATH_ENV = 'NEXT_ADAPTER_PATH';
export const ADAPTER_PACKAGE = '@stayingupwind/adapter';

/**
 * The adapter this run will use: the one the environment already names, or the project's own copy.
 * Nothing is written; nothing is said.
 */
export function resolveAdapterPath(projectDir: string): string | undefined {
  const configured = process.env[ADAPTER_PATH_ENV];
  if (configured !== undefined && configured !== '') {
    return configured;
  }
  return resolveFromProject(projectDir, ADAPTER_PACKAGE);
}

/** Name it for the processes that follow, and say what a project without one is missing. */
export function installAdapterPath(projectDir: string): string | undefined {
  const resolved = resolveAdapterPath(projectDir);
  if (resolved === undefined) {
    console.warn(
      `upwind: ${ADAPTER_PACKAGE} is not installed in this project, so nothing reserves /__upwind inside Next.js's own routing — this server still answers it first`,
    );
    return undefined;
  }
  process.env[ADAPTER_PATH_ENV] = resolved;
  return resolved;
}
