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
 */

/** What Next.js's default config reads an adapter module's path from (`config-shared.ts`). */
const ADAPTER_PATH_ENV = 'NEXT_ADAPTER_PATH';
const ADAPTER_PACKAGE = '@stayingupwind/adapter';

export function installAdapterPath(projectDir: string): string | undefined {
  const configured = process.env[ADAPTER_PATH_ENV];
  if (configured !== undefined && configured !== '') {
    return configured;
  }
  const resolved = resolveFromProject(projectDir, ADAPTER_PACKAGE);
  if (resolved === undefined) {
    console.warn(
      `upwind: ${ADAPTER_PACKAGE} is not installed in this project, so nothing reserves /__upwind inside Next.js's own routing — this server still answers it first`,
    );
    return undefined;
  }
  process.env[ADAPTER_PATH_ENV] = resolved;
  return resolved;
}
