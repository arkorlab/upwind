import type { AuthContext } from 'better-auth';

import { isProjectDatabase } from './database.ts';
import { isProduction } from './environment.ts';

/**
 * The tables, created once, in the one case where creating them is upwind's business.
 *
 * Better Auth ships a migration it can run itself — `auth.$context` carries `runMigrations` — and a
 * project would ordinarily run it from the CLI. That step is exactly the kind of thing this package
 * exists to remove: a developer who has written `auth.ts` and pressed sign-in should not be met by
 * a message about a table that does not exist, in a database they never chose, on the first run of
 * a project that has nothing in it yet.
 *
 * So it runs, and only here:
 *
 * - **not in production.** A deployed Function issuing DDL on its first request is a deployment
 *   that changes its own schema at a moment nobody picked; migrations there belong to whatever
 *   deploys it.
 * - **not in a database the project configured.** `projectDatabase` records the ones upwind chose
 *   (`database.ts`). A database named in `auth.ts` may be one a team shares, and upwind has no
 *   standing to create tables in it — that project runs Better Auth's migration itself.
 *
 * Once per auth instance, not once per module: two instances would be two databases, and a module
 * that remembered the first would leave the second without tables. Awaited by every request that
 * arrives while the first one is still going, because the alternative is the second request
 * querying tables the first has not finished creating.
 */

/** As much of an auth object as this needs, so a project's own `betterAuth` call fits too. */
export interface Migratable {
  readonly options: { readonly database?: unknown };
  readonly $context: Promise<AuthContext>;
}

/** What is being done about each instance's schema, so it is done once and waited for by all. */
const running = new WeakMap<Migratable, Promise<void>>();

/**
 * The migration itself, which forgets itself if it fails.
 *
 * A failure belongs to the attempt rather than to the process: a dev server started before its
 * storage was ready would otherwise have to be restarted to get past one bad moment. Forgotten
 * here, inside the work, so that nothing outside has to hold a promise only to watch it.
 */
async function migrate(auth: Migratable): Promise<void> {
  try {
    const ctx = await auth.$context;
    await ctx.runMigrations();
  } catch (error) {
    running.delete(auth);
    throw error;
  }
}

export async function ensureSchema(auth: Migratable): Promise<void> {
  if (isProduction() || !isProjectDatabase(auth.options.database)) {
    return;
  }
  let pending = running.get(auth);
  if (pending === undefined) {
    pending = migrate(auth);
    running.set(auth, pending);
  }
  await pending;
}
