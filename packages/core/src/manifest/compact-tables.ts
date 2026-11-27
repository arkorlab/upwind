import { canonicalJson } from '../artifact/hash.ts';
import type { GenerationTag } from '../cache/tag-schema.ts';
import { compareCodeUnits, encodeUtf8 } from '../util/bytes.ts';
import type { ProjectManifest, RouteEntry, RouteSegment } from './schema.ts';

type TableName = 'buildTags' | 'segments';

interface Occurrence<T> {
  readonly value: T;
  uses: number;
  index?: number;
}

/** Publication only. Identical values are compared by all their canonical fields. */
class CandidateTable<T extends GenerationTag | RouteSegment> {
  private readonly byJson = new Map<string, Occurrence<T>>();
  private readonly byObject = new WeakMap<T, Occurrence<T>>();

  count(value: T): void {
    let occurrence = this.byObject.get(value);
    if (occurrence === undefined) {
      const json = canonicalJson(value);
      occurrence = this.byJson.get(json);
      if (occurrence === undefined) {
        occurrence = { value, uses: 0 };
        this.byJson.set(json, occurrence);
      }
      this.byObject.set(value, occurrence);
    }
    occurrence.uses += 1;
  }

  /** Keep a table only if the complete UTF-8 representation saves bytes, including its name. */
  select(name: TableName): T[] | undefined {
    const table: T[] = [];
    // Charge the comma before this field (headers always exists) and both brackets. The
    // first element has no preceding comma; every subsequent element has exactly one.
    let saved = -`,"${name}":[]`.length;
    for (const [json, occurrence] of this.byJson) {
      if (occurrence.uses < 2) continue;
      const copiesRemoved = (occurrence.uses - 1) * encodeUtf8(json).byteLength;
      const indexBytes = occurrence.uses * String(table.length).length;
      const gain = copiesRemoved - indexBytes - Number(table.length > 0);
      if (gain > 0) {
        saved += gain;
        occurrence.index = table.length;
        table.push(occurrence.value);
      }
    }
    return saved > 0 ? table : undefined;
  }

  reference(value: T): T | number {
    return this.byObject.get(value)?.index ?? value;
  }
}

interface CompactRouteTables {
  readonly tables: { readonly buildTags?: GenerationTag[]; readonly segments?: RouteSegment[] };
  readonly fields: (route: RouteEntry) => Readonly<Record<string, unknown>>;
}

function countRoute(
  route: RouteEntry,
  tags: CandidateTable<GenerationTag>,
  segments: CandidateTable<RouteSegment>,
): void {
  const buildTags = route.cache?.buildTags;
  if (buildTags !== undefined) {
    for (const tag of buildTags) tags.count(tag);
  }
  if (route.segments === undefined) return;
  const keys = Object.keys(route.segments).toSorted(compareCodeUnits);
  for (const key of keys) {
    const segment = route.segments[key];
    if (segment !== undefined) segments.count(segment);
  }
}

/** The two optional dictionaries, selected independently. Entries used only once stay inline. */
export function compactRouteTables(
  routes: ProjectManifest['routes'],
): CompactRouteTables | undefined {
  const tags = new CandidateTable<GenerationTag>();
  const segments = new CandidateTable<RouteSegment>();
  const paths = Object.keys(routes).toSorted(compareCodeUnits);
  for (const path of paths) {
    const route = routes[path];
    if (route !== undefined) countRoute(route, tags, segments);
  }
  const tagTable = tags.select('buildTags');
  const segmentTable = segments.select('segments');
  if (tagTable === undefined && segmentTable === undefined) return;
  return {
    tables: {
      ...(tagTable !== undefined && { buildTags: tagTable }),
      ...(segmentTable !== undefined && { segments: segmentTable }),
    },
    fields: (route) => {
      const fields: Record<string, unknown> = {};
      if (tagTable !== undefined && route.cache?.buildTags !== undefined) {
        fields['cache'] = {
          ...route.cache,
          buildTags: route.cache.buildTags.map((tag) => tags.reference(tag)),
        };
      }
      if (segmentTable !== undefined && route.segments !== undefined) {
        const entries = Object.entries(route.segments);
        fields['segments'] = Object.fromEntries(
          entries.map(([name, segment]) => [name, segments.reference(segment)]),
        );
      }
      return fields;
    },
  };
}
