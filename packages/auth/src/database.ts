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
export type ProjectDatabase = Pick<typeof db, 'batch' | 'exec' | 'prepare'>;

/**
 * The one this run hands out, built here rather than per call.
 *
 * There is one database behind it — the one D1 the deployment published — so there is no sense in
 * two objects standing for it, and one real consequence if there were: creating the tables is
 * guarded per database (`schema.ts`), and two facades would be two guards over one schema, each
 * able to run the migration while the other was running it.
 *
 * Building it at module evaluation costs nothing and touches nothing. The three methods close over
 * the SDK's stand-in, which resolves when one of them is *called* — so this is three function
 * objects, made before any request, that between them have not asked about storage.
 */
const CHOSEN: ProjectDatabase = {
  prepare: (query) => db.prepare(query),
  batch: async (statements) => db.batch(statements),
  exec: async (query) => db.exec(query),
};

export function projectDatabase(): ProjectDatabase {
  return CHOSEN;
}

/**
 * Did this database come from `projectDatabase`, rather than from the project's own config?
 *
 * Identity, which is the whole of the question: there is one object this hands out, and anything
 * else — a dialect, a Kysely instance, another D1 — is the project's. What rests on the answer is
 * whether it is upwind's place to create the tables (`schema.ts`): doing it in a database upwind
 * picked out of this run's own storage is housekeeping, and doing it in one a developer configured,
 * which may be a database a team shares, is not upwind's to do.
 */
export function isProjectDatabase(value: unknown): value is ProjectDatabase {
  return value === CHOSEN;
}
