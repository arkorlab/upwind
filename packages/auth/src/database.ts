import db from '@stayingupwind/sdk/db';

/**
 * The database an unconfigured project gets: the one D1 its deployment published.
 *
 * `@stayingupwind/sdk/db` already answers exactly that question — one of a kind, whatever it is
 * called — and answers it the same way for `upwind dev`, for `upwind build` and for a deployed
 * Function. So there is nothing to configure and nothing to name, which is the whole of why
 * authentication can start from an empty project at all.
 *
 * What is here instead of the database itself is three methods that forward to it. Better Auth
 * decides what kind of database it was handed by asking, in order, whether the object has `open`,
 * `close` and `prepare` (a SQLite file) and then whether it has `batch`, `exec` and `prepare` (D1) —
 * and the SDK's export is a stand-in that resolves the moment anything is *asked* of it, including
 * whether it has a property. Handed over directly, the first of those questions would resolve the
 * storage: at module evaluation, which in a Function is before the environment its bindings come
 * from has arrived.
 *
 * Three plain methods answer both questions without touching anything — `open` is absent, the D1
 * three are present — and the storage is reached on the first query instead, where the SDK's own
 * message about what is published belongs. The same shape is what keeps `runMigrations` reachable:
 * Better Auth refuses to migrate an object that has `updateMany`, which is how it tells a database
 * from an adapter, and this has no such property either.
 *
 * `prepare` and `batch` are what the dialect uses; `exec` is there because the detection above asks
 * for it. A release that reaches for a fourth method finds it missing and says so, which is the
 * failure to want here — the alternative, a stand-in that forwards everything, is the one that
 * resolves storage during detection and takes us back to where this started.
 */

/** As much of Cloudflare's object as Better Auth ever looks for. */
type ProjectDatabase = Pick<typeof db, 'batch' | 'exec' | 'prepare'>;

/**
 * Which databases upwind chose rather than the project.
 *
 * Kept so that one later decision can be made honestly: whether it is upwind's place to create the
 * tables (`schema.ts`). Creating them in a database upwind picked out of this run's own storage is
 * housekeeping; creating them in one a developer configured — which may be a database a team
 * shares — is not upwind's to do. A `WeakSet` rather than a flag on the object, so that nothing
 * about the answer is visible to Better Auth or reachable from the application.
 */
const chosenByUpwind = new WeakSet<ProjectDatabase>();

export function projectDatabase(): ProjectDatabase {
  const database: ProjectDatabase = {
    prepare: (query) => db.prepare(query),
    batch: async (statements) => db.batch(statements),
    exec: async (query) => db.exec(query),
  };
  chosenByUpwind.add(database);
  return database;
}

/** Did this database come from `projectDatabase`, rather than from the project's own config? */
export function isProjectDatabase(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && chosenByUpwind.has(value as ProjectDatabase)
  );
}
