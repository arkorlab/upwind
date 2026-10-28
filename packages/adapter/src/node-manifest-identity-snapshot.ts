import {
  roots,
  record,
  ownRecord,
  assertProperties,
  assertCollection,
  refuse,
  type RecordSnapshot,
  type Budget,
  type IdentityObject,
  identityObject,
} from './node-manifest-identity-records.ts';
export { NodeManifestIdentityError } from './node-manifest-identity-records.ts';
const SNAPSHOT: unique symbol = Symbol('original source identity snapshot');
const OWN: unique symbol = Symbol('private control wrapper identity snapshot');
const MAX_OBJECTS = 100_000;
const MAX_DEPTH = 256;
export interface NodeManifestIdentitySnapshot {
  readonly [SNAPSHOT]: true;
}
export interface NodeManifestOwnIdentitySnapshot {
  readonly [OWN]: true;
}
interface Stored {
  readonly roots: readonly unknown[];
  readonly records: readonly RecordSnapshot[];
}
const SNAPSHOTS = new WeakMap<NodeManifestIdentitySnapshot, Stored>();
const OWN_SNAPSHOTS = new WeakMap<NodeManifestOwnIdentitySnapshot, Stored>();
function children(recorded: RecordSnapshot): readonly unknown[] {
  const values = recorded.properties.map((property) => property.value);
  const collection = recorded.collection;
  if (collection.kind === 'map')
    for (const entry of collection.entries) values.push(entry[0], entry[1]);
  else if (collection.kind === 'set') for (const entry of collection.entries) values.push(entry);
  return values;
}
function capture(original: readonly unknown[]): readonly RecordSnapshot[] {
  const active = new WeakSet<IdentityObject>();
  const complete = new WeakSet<IdentityObject>();
  const pending: { readonly value: unknown; readonly depth: number; readonly exit?: boolean }[] =
    original.map((value) => ({ value, depth: 0 }));
  const records: RecordSnapshot[] = [];
  const budget: Budget = { objects: 0, entries: 0 };
  for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
    const value = frame.value;
    if (typeof value === 'function') return refuse('function');
    if (!identityObject(value)) continue;
    if (frame.exit === true) {
      active.delete(value);
      complete.add(value);
      continue;
    }
    if (active.has(value)) return refuse('cycle');
    if (complete.has(value)) continue;
    budget.objects += 1;
    if (budget.objects > MAX_OBJECTS || frame.depth > MAX_DEPTH)
      return refuse('object or depth bound');
    active.add(value);
    const recorded = record(value, budget);
    records.push(recorded);
    pending.push({ value, depth: frame.depth, exit: true });
    for (const child of children(recorded)) pending.push({ value: child, depth: frame.depth + 1 });
  }
  return Object.freeze(records);
}
/** Original data identities and values only; no runtime, source-origin or semantic authority. */
export function captureNodeManifestIdentity(
  values: readonly unknown[],
): NodeManifestIdentitySnapshot {
  const original = roots(values);
  const records = capture(original);
  const snapshot = Object.freeze<NodeManifestIdentitySnapshot>({ [SNAPSHOT]: true });
  SNAPSHOTS.set(snapshot, Object.freeze({ roots: original, records }));
  return snapshot;
}
/** Rechecks every original record and ordered collection; never a cached successful boolean. */
export function assertNodeManifestIdentity(
  snapshot: NodeManifestIdentitySnapshot,
  values: readonly unknown[],
): void {
  const known = SNAPSHOTS.get(snapshot);
  if (known === undefined) return refuse('copied or uncertified snapshot');
  const actual = roots(values);
  if (
    actual.length !== known.roots.length ||
    actual.some((value, index) => !Object.is(value, known.roots[index]))
  )
    return refuse('changed root identity');
  for (const recorded of known.records) {
    assertProperties(recorded);
    assertCollection(recorded);
  }
}
/** Private control wrappers only; this never replaces a deep source/graph snapshot. */
export function captureNodeManifestOwnIdentity(
  values: readonly unknown[],
): NodeManifestOwnIdentitySnapshot {
  const original = roots(values);
  const budget: Budget = { objects: 0, entries: 0 };
  const records = Object.freeze(original.map((value) => ownRecord(value, budget)));
  const snapshot = Object.freeze<NodeManifestOwnIdentitySnapshot>({ [OWN]: true });
  OWN_SNAPSHOTS.set(snapshot, Object.freeze({ roots: original, records }));
  return snapshot;
}
/** Separate opaque type/private ledger: an own-only token cannot pass the deep assertion. */
export function assertNodeManifestOwnIdentity(
  snapshot: NodeManifestOwnIdentitySnapshot,
  values: readonly unknown[],
): void {
  const known = OWN_SNAPSHOTS.get(snapshot);
  if (known === undefined) return refuse('copied or uncertified own snapshot');
  const actual = roots(values);
  if (
    actual.length !== known.roots.length ||
    actual.some((value, index) => !Object.is(value, known.roots[index]))
  )
    return refuse('changed control root identity');
  for (const recorded of known.records) assertProperties(recorded);
}
