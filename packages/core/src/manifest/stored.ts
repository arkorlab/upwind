import { canonicalJson } from '../artifact/hash.ts';
import type { ProjectManifest } from './schema.ts';

/**
 * A manifest as it is stored: what a route repeats of every other, said once.
 *
 * A route carries the response headers its page answers with, the conditions under which Next.js
 * would not serve its prerender, and the resources its head names. Across a build those are a few
 * values, repeated: every page under one layout answers with the same policy and preloads the
 * same stylesheet, and every member of a class carries the class's conditions. Written out on
 * each route, they were most of what a route cost — some two kilobytes each, which is what kept a
 * manifest under its limit to a few thousand pages, and what an edge parsed and held for every one.
 *
 * So the stored manifest holds each distinct value once, in `tables`, and a route names it by its
 * place there. Read, the tables go back into the routes (`fromStoredManifest`), each value one
 * object however many routes share it, and nothing that reads a manifest sees the difference.
 * A manifest with no `tables` — every one published before them — is read as it is.
 */

/** The distinct values a stored manifest's routes name by their place. */
interface Tables {
  readonly headers: unknown[];
  readonly conditions: unknown[];
  readonly preloads: unknown[];
}

/** One table being written: each distinct value once, in the order first met. */
class TableWriter {
  private readonly places = new Map<string, number>();
  readonly values: unknown[] = [];

  /** The place of `value`, added at the end the first time it is met. */
  placeOf(value: unknown): number {
    const key = canonicalJson(value);
    const held = this.places.get(key);
    if (held !== undefined) {
      return held;
    }
    const place = this.values.length;
    this.values.push(value);
    this.places.set(key, place);
    return place;
  }
}

/** The manifest as it is stored and named: each route's repeated values put in `tables`. */
export function toStoredManifest(manifest: ProjectManifest): Record<string, unknown> {
  const headers = new TableWriter();
  const conditions = new TableWriter();
  const preloads = new TableWriter();
  const routes = Object.fromEntries(
    Object.entries(manifest.routes).map(([key, entry]) => {
      const stored = {
        ...entry,
        headers: headers.placeOf(entry.headers),
        ...(entry.bypassFor !== undefined && { bypassFor: conditions.placeOf(entry.bypassFor) }),
        ...(entry.preloads !== undefined && { preloads: preloads.placeOf(entry.preloads) }),
      };
      return [key, stored];
    }),
  );
  const dynamicRoutes = manifest.dynamicRoutes?.map((route) => {
    const { members } = route;
    return members === undefined
      ? route
      : { ...route, members: { ...members, bypassFor: conditions.placeOf(members.bypassFor) } };
  });
  const tables = {
    headers: headers.values,
    ...(conditions.values.length > 0 && { conditions: conditions.values }),
    ...(preloads.values.length > 0 && { preloads: preloads.values }),
  };
  return {
    ...manifest,
    routes,
    ...(dynamicRoutes !== undefined && { dynamicRoutes }),
    tables,
  };
}

type Stored = Record<string, unknown>;

function isRecord(value: unknown): value is Stored {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tableOf(tables: Stored, name: keyof Tables): unknown[] {
  const table = tables[name];
  return Array.isArray(table) ? table : [];
}

/** The value a route names by its place in `table`; a place the table does not hold is refused. */
function placed(table: readonly unknown[], place: unknown, what: string): unknown {
  if (
    typeof place !== 'number' ||
    !Number.isSafeInteger(place) ||
    place < 0 ||
    place >= table.length
  ) {
    throw new Error(
      `a route names ${what} ${String(place)}, which the manifest's table does not hold`,
    );
  }
  return table[place];
}

/** A route as it is read: what it names by place, put back. */
function readRoute(entry: unknown, tables: Tables): unknown {
  if (!isRecord(entry)) {
    return entry;
  }
  return {
    ...entry,
    headers: placed(tables.headers, entry['headers'], 'headers'),
    ...(entry['bypassFor'] !== undefined && {
      bypassFor: placed(tables.conditions, entry['bypassFor'], 'conditions'),
    }),
    ...(entry['preloads'] !== undefined && {
      preloads: placed(tables.preloads, entry['preloads'], 'preloads'),
    }),
  };
}

/** A dynamic route as it is read: its members' conditions put back. */
function readDynamicRoute(route: unknown, tables: Tables): unknown {
  const members = isRecord(route) ? route['members'] : undefined;
  if (!isRecord(route) || !isRecord(members)) {
    return route;
  }
  const bypassFor = placed(tables.conditions, members['bypassFor'], 'conditions');
  return { ...route, members: { ...members, bypassFor } };
}

/**
 * A stored manifest as it is read: what its routes name by place in `tables` put back, so a
 * manifest reads the same however it was stored. Every route sharing a value is handed the one
 * object. A manifest without `tables` is handed back as it is, and so is anything that is not a
 * manifest at all, for the schema to refuse.
 */
export function fromStoredManifest(parsed: unknown): unknown {
  if (!isRecord(parsed) || !isRecord(parsed['tables'])) {
    return parsed;
  }
  const { tables: stored, ...manifest } = parsed;
  const tables: Tables = {
    headers: tableOf(stored, 'headers'),
    conditions: tableOf(stored, 'conditions'),
    preloads: tableOf(stored, 'preloads'),
  };
  const listed = manifest['routes'];
  const routes = isRecord(listed)
    ? Object.fromEntries(
        Object.entries(listed).map(([key, entry]) => [key, readRoute(entry, tables)]),
      )
    : listed;
  const classes = manifest['dynamicRoutes'];
  const dynamicRoutes = Array.isArray(classes)
    ? classes.map((route) => readDynamicRoute(route, tables))
    : classes;
  return {
    ...manifest,
    routes,
    ...(dynamicRoutes !== undefined && { dynamicRoutes }),
  };
}
