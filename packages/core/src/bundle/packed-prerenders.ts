/**
 * How a Function's runtime manifest (`runtime.json`) carries the deployment's prerenders: a field
 * whose values repeat from record to record is written once for each value it takes, and each
 * record holds the place of its value in that list.
 *
 * A Function reads the whole manifest before it answers its first request, and the prerenders are
 * most of it: a record for every page the build rendered, with the headers it is served with, the
 * request headers its renders may see, the conditions that bypass it, its route and its body. Most
 * of that is the same for every page of a route, or of the build, and was written out again in
 * each record. A manifest of 3,500 prerenders came to 5.1 MiB that way, took 10 ms to read, and
 * held 6.5 MiB of the isolate's memory once read; written as here, it is 2.2 MiB, reads in 6 ms,
 * and holds 2.3 MiB.
 *
 * Which fields are written once per value is the writer's to decide from what it writes: a field
 * is when its values, written once, and a place in each record that has it come to fewer bytes
 * than the field written in every record — a route, say, and never a pathname. The reader puts the
 * values back, so what it hands on is the records as they were before they were written, except
 * that the records that hold a value hold the one copy of it: nothing that reads a prerender may
 * change one.
 */

/** A prerender as this module reads one: its fields, by name. */
type Fields = Readonly<Record<string, unknown>>;

/** Prerenders as a runtime manifest carries them. */
export interface PackedPrerenders {
  /** Each field written once per value: its values, in the order the records first hold them. */
  readonly values: Readonly<Record<string, readonly unknown[]>>;
  /** Every prerender, in order, with the place of its value in `values` for a field written there. */
  readonly records: readonly Fields[];
}

/** A field of the records being written: what it weighs in each, and the values it takes. */
interface Field {
  /** Bytes of its value in every record that has it, as JSON. */
  inline: number;
  /** Each value it takes, by its JSON, with its place and the value itself as first met. */
  readonly values: Map<string, { readonly place: number; readonly value: unknown }>;
}

/** Every field of the records, as `written` has them as JSON, with the values each takes. */
function fieldsOf(
  written: readonly ReadonlyMap<string, string>[],
  prerenders: readonly Fields[],
): Map<string, Field> {
  const fields = new Map<string, Field>();
  for (const [at, record] of written.entries()) {
    for (const [key, json] of record) {
      let field = fields.get(key);
      if (field === undefined) {
        field = { inline: 0, values: new Map() };
        fields.set(key, field);
      }
      field.inline += json.length;
      if (!field.values.has(json)) {
        field.values.set(json, { place: field.values.size, value: prerenders[at]?.[key] });
      }
    }
  }
  return fields;
}

/** Whether a field weighs less written once per value, with a place in each record that has it. */
function worthPacking(
  key: string,
  field: Field,
  written: readonly ReadonlyMap<string, string>[],
): boolean {
  // Each value, and the comma after it; then each record's place, as long as its digits.
  let packed = 0;
  for (const json of field.values.keys()) {
    packed += json.length + 1;
  }
  for (const record of written) {
    const json = record.get(key);
    const place = json === undefined ? undefined : field.values.get(json)?.place;
    packed += place === undefined ? 0 : String(place).length;
  }
  return packed < field.inline;
}

/** The prerenders, to be written in a runtime manifest: see the module's comment. */
export function packPrerenders(prerenders: readonly Fields[]): PackedPrerenders {
  // Each record's fields as JSON writes them: a field that is `undefined` is not written.
  const written = prerenders.map((prerender) => {
    const fields = Object.entries(prerender).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, JSON.stringify(value)] as const],
    );
    return new Map(fields);
  });
  const fields = new Map(
    [...fieldsOf(written, prerenders)].filter(([key, field]) => worthPacking(key, field, written)),
  );
  const values = Object.fromEntries(
    [...fields].map(([key, field]) => [key, [...field.values.values()].map(({ value }) => value)]),
  );
  const records = written.map((record, at) => {
    const entries = [...record].map(([key, json]) => {
      const place = fields.get(key)?.values.get(json)?.place;
      return [key, place ?? prerenders[at]?.[key]] as const;
    });
    return Object.fromEntries(entries);
  });
  return { values, records };
}

/**
 * The prerenders a runtime manifest carries, as they were before `packPrerenders` wrote them: each
 * value put back in the records that hold its place. The records are the ones handed in, just read
 * from the manifest, and are changed where they are rather than copied.
 */
export function unpackPrerenders<T>(packed: PackedPrerenders): T[] {
  if (Array.isArray(packed)) {
    throw new TypeError(
      'runtime manifest: its prerenders are a list, where they are written packed',
    );
  }
  const fields = Object.entries(packed.values);
  const records = packed.records as Record<string, unknown>[];
  for (const record of records) {
    for (const [key, values] of fields) {
      const place = record[key];
      if (place === undefined) {
        continue;
      }
      const value = typeof place === 'number' ? values[place] : undefined;
      if (value === undefined) {
        throw new TypeError(
          `runtime manifest: a prerender holds ${JSON.stringify(place)} for ${key}, which is not the place of one of its ${String(values.length)} values`,
        );
      }
      record[key] = value;
    }
  }
  return records as T[];
}
