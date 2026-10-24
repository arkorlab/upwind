/**
 * The fixture's "database": counters held by the isolate, on the global so that the route
 * handler that bumps them and the page that reads them share one, whichever module graphs
 * Turbopack compiled each into. A cached render shows the version it read and which render it
 * was, so a body says whether it was rendered again or served as kept; the revalidation route
 * bumps the version, and the next render shows the new one.
 */

export interface Snapshot {
  readonly version: number;
  readonly renders: number;
}

function state(): { version: number; renders: number } {
  if (globalThis.fixtureDb === undefined) {
    Reflect.set(globalThis, 'fixtureDb', { version: 1, renders: 0 });
  }
  return globalThis.fixtureDb ?? { version: 0, renders: 0 };
}

/** Read for a render, counting it. */
export function readForRender(): Snapshot {
  const db = state();
  db.renders += 1;
  return { version: db.version, renders: db.renders };
}

export function bump(): number {
  const db = state();
  db.version += 1;
  return db.version;
}
