import { UPWIND_AUTH_SECRET_ENV } from '@stayingupwind/core/paas';

import { authLayout } from './layout.ts';
import { ensureAuthRoute } from './route.ts';
import { projectAuthSecret } from './secret.ts';

/**
 * Everything a run does about authentication before it runs anything of the project's.
 *
 * Two things, and both have to happen while the project is still a directory rather than a running
 * server: the route has to be on disk before the bundler reads `app`, and the secret has to be in
 * the environment before any module that reads it is evaluated.
 *
 * A project with no auth config gets neither — and gets the route taken back, if a previous run
 * wrote one. That is the whole of the cost this imposes on the projects that never asked for any:
 * two `existsSync` calls (`layout.ts`) and two attempts to read a file that is not there.
 *
 * Nothing here can end a run. Each step already answers for itself, and this catches whatever they
 * did not think of — because what is at stake either way is authentication, and a dev server that
 * refused to start over it would take the application down with it. A run that got none of this is
 * a run where sign-in does not work and everything else does, which is a thing a developer can see
 * and act on. `dev/agent-rules.ts` takes the same view of the same kind of work.
 */

/**
 * The environment the rest of this run should carry, which is nothing at all for a project that has
 * no auth config or could not be given a secret.
 */
export async function prepareAuth(projectDir: string): Promise<Record<string, string>> {
  try {
    const layout = authLayout(projectDir);
    await ensureAuthRoute(projectDir, layout);
    if (layout === undefined) {
      return {};
    }
    const secret = await projectAuthSecret(projectDir);
    return secret === undefined ? {} : { [UPWIND_AUTH_SECRET_ENV]: secret };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`upwind: could not set this project's authentication up (${reason})`);
    return {};
  }
}
