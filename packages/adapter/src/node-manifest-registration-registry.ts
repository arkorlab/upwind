import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { AuditError } from './dependencies.ts';
import {
  certifyNodeManifestRegistrationGroup,
  nodeManifestRegistrationGroup,
  type NodeManifestRegistrationGroupInput,
  type NodeManifestRegistrationGroupProof,
} from './node-manifest-registration-group.ts';
import {
  nodeManifestRuntimeCohortSources,
  nodeManifestRuntimeCohortLookup,
  type NodeManifestRuntimeCohort,
} from './node-manifest-runtime-cohort.ts';
import { nodeManifestRuntimeTables } from './node-manifest-runtime-tables.ts';
import { assertTurbopackAsyncGraph } from './node-manifest-turbopack-async-graph.ts';
import { assertTurbopackCacheOwners } from './node-manifest-turbopack-cache.ts';
import type {
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';
import {
  nodeManifestTurbopackFactories,
  projectNodeManifestTurbopackFactory,
  turbopackModuleSpecifier,
  type NodeManifestTurbopackFactory,
  type NodeManifestTurbopackModuleId,
  type NodeManifestTurbopackProjection,
  type NodeManifestTurbopackImport,
} from './node-manifest-turbopack.ts';

const SCOPE: unique symbol = Symbol('runtime registration scope');
const INDEX: unique symbol = Symbol('runtime registration index');
const MAX_DIAGNOSTIC_REASONS = 12;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 320;
const PROTOCOL_SUFFIX = '; refusing native publication';
const PROTOCOL_PREFIXES = [
  'Unproved Next.js Turbopack manifest ',
  'Unproved Next.js Turbopack cache initializer ',
];
export interface NodeManifestRegistrationScope {
  readonly [SCOPE]: true;
}
export interface NodeManifestRegistrationIndex {
  readonly [INDEX]: true;
}
export interface NodeManifestRegistrationRecord {
  readonly physical: NodeManifestTurbopackGraphFile;
  readonly projection: NodeManifestTurbopackProjection;
}
export interface NodeManifestLogicalRegistration {
  readonly id: string;
  readonly moduleId: NodeManifestTurbopackModuleId;
  readonly members: readonly string[];
}
export interface NodeManifestRegistrationView {
  readonly runtimeId: string;
  readonly rows: readonly NodeManifestTurbopackGraphFactory[];
  readonly records: readonly NodeManifestRegistrationRecord[];
  readonly registrations: readonly NodeManifestLogicalRegistration[];
}
interface Callback {
  readonly physical: NodeManifestTurbopackGraphFile;
  readonly factory: NodeManifestTurbopackFactory;
  readonly projections: readonly NodeManifestTurbopackProjection[];
}
interface GroupCheck {
  readonly proof: NodeManifestRegistrationGroupProof;
  readonly input: NodeManifestRegistrationGroupInput;
}
interface ScopeState {
  readonly cohort: NodeManifestRuntimeCohort;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly owner: { readonly identity: symbol };
  readonly fingerprint: string;
  readonly indexes: Map<string, NodeManifestRegistrationIndex>;
}
interface IndexState {
  readonly input: RegistryInput;
  readonly runtime: NodeManifestTurbopackGraphFile;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly tables: readonly NodeManifestTurbopackGraphFile[];
  readonly fingerprint: string;
  readonly groups: readonly GroupCheck[];
  readonly view: NodeManifestRegistrationView;
  readonly viewFingerprint: string;
}
interface RegistryInput {
  readonly distDir: string;
  readonly runtime: NodeManifestTurbopackGraphFile;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly tables: readonly NodeManifestTurbopackGraphFile[];
  readonly cohort?: NodeManifestRuntimeCohort | undefined;
  readonly scope?: NodeManifestRegistrationScope | undefined;
}
const SCOPES = new WeakMap<NodeManifestRegistrationScope, ScopeState>();
const INDEXES = new WeakMap<NodeManifestRegistrationIndex, IndexState>();

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack consumer graph ${reason}; refusing native publication`,
  );
}
function fingerprint(value: unknown): string {
  const hashes = new Map<string, string>();
  const json = JSON.stringify(value, (key, item: unknown) => {
    if (key !== 'code' || typeof item !== 'string') return item;
    const known = hashes.get(item);
    if (known !== undefined) return known;
    const hash = createHash('sha256').update(item).digest('hex');
    hashes.set(item, hash);
    return hash;
  });
  if (typeof json !== 'string') return refuse('registration fingerprint');
  return createHash('sha256').update(json).digest('hex');
}

/** No successful subset can become a registry after an ordinary projection fails. */
class FactoryDiagnostics {
  private readonly reasons = new Map<string, number>();
  private failures = 0;
  private omitted = 0;
  capture(error: unknown): void {
    if (
      !(error instanceof AuditError) ||
      error.message.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH ||
      PROTOCOL_PREFIXES.every((prefix) => !error.message.startsWith(prefix)) ||
      !error.message.endsWith(PROTOCOL_SUFFIX)
    )
      throw error;
    this.failures += 1;
    const count = this.reasons.get(error.message);
    if (count !== undefined) this.reasons.set(error.message, count + 1);
    else if (this.reasons.size < MAX_DIAGNOSTIC_REASONS) this.reasons.set(error.message, 1);
    else this.omitted += 1;
  }
  assertNone(): void {
    if (this.failures === 0) return;
    const reasons = [...this.reasons].map(([reason, count]) => `${count}x ${reason}`).join(' | ');
    throw new AuditError(
      `Unproved Next.js Turbopack manifest diagnostics (${this.failures} failures; ${this.reasons.size} reasons shown; ${this.omitted} omitted failures): ${reasons}`,
    );
  }
}
function callback(
  table: NodeManifestTurbopackGraphFile,
  factory: NodeManifestTurbopackFactory,
  diagnostics: FactoryDiagnostics,
): Callback {
  const projections: NodeManifestTurbopackProjection[] = [];
  for (const id of factory.ids) {
    try {
      projections.push(projectNodeManifestTurbopackFactory(table.source, id, 'dependencies'));
    } catch (error) {
      diagnostics.capture(error);
    }
  }
  return { physical: table, factory, projections };
}
function callbacks(tables: RegistryInput['tables']): readonly Callback[] {
  const result: Callback[] = [];
  const diagnostics = new FactoryDiagnostics();
  for (const table of tables) {
    try {
      for (const factory of nodeManifestTurbopackFactories(table.source))
        result.push(callback(table, factory, diagnostics));
    } catch (error) {
      diagnostics.capture(error);
    }
  }
  diagnostics.assertNone();
  return result;
}
function completeVectors(values: readonly Callback[]): ReadonlyMap<string, readonly Callback[]> {
  const owners = new Map<NodeManifestTurbopackModuleId, string>();
  const groups = new Map<string, Callback[]>();
  for (const value of values) {
    const key = JSON.stringify(value.factory.ids);
    for (const id of value.factory.ids) {
      const previous = owners.get(id);
      if (previous !== undefined && previous !== key)
        refuse('duplicate module id across loaded chunks');
      owners.set(id, key);
    }
    const members = groups.get(key) ?? [];
    members.push(value);
    groups.set(key, members);
  }
  return groups;
}
function scopeState(input: RegistryInput): ScopeState | undefined {
  if (input.scope === undefined) return undefined;
  const state = SCOPES.get(input.scope);
  if (
    state === undefined ||
    state.cohort !== input.cohort ||
    state.sources !== input.sources ||
    state.fingerprint !== fingerprint(input.sources)
  )
    return refuse('stale registration scope');
  const runtimes = nodeManifestRuntimeCohortSources(state.cohort, input.sources);
  if (
    runtimes.every((runtime) => runtime.id !== input.runtime.id) ||
    input.sources.find((source) => source.id === input.runtime.id) !== input.runtime
  )
    refuse('registration runtime binding');
  return state;
}
function assertInstallation(input: RegistryInput): void {
  const runtimeIds = new Set(
    input.cohort === undefined
      ? [input.runtime.id]
      : nodeManifestRuntimeCohortSources(input.cohort, input.sources).map((runtime) => runtime.id),
  );
  const lookup = new Map<string, NodeManifestTurbopackGraphFile>();
  for (const edge of input.runtime.imports) {
    if (isBuiltin(edge.target) || edge.target === input.runtime.id) continue;
    if (runtimeIds.has(edge.target)) {
      if (
        input.cohort === undefined ||
        !nodeManifestRuntimeCohortLookup(input.cohort, input.runtime.id, edge)
      )
        refuse('unproved cross-runtime table edge');
      continue;
    }
    const target = input.sources.find((source) => source.id === edge.target);
    if (target === undefined) refuse('unclosed runtime table target');
    lookup.set(target.id, target);
  }
  const expected = nodeManifestRuntimeTables({
    ...input,
    tables: [...lookup.values()],
    runtimeIds,
  });
  if (
    expected.length !== input.tables.length ||
    expected.some((table) => !input.tables.includes(table))
  )
    refuse('registration installed table mismatch');
}

/** Created only after the real cohort is sealed, never by the pre-cohort caller inventory. */
export function createNodeManifestRegistrationScope(
  cohort: NodeManifestRuntimeCohort,
  sources: RegistryInput['sources'],
): NodeManifestRegistrationScope {
  nodeManifestRuntimeCohortSources(cohort, sources);
  const scope = Object.freeze<NodeManifestRegistrationScope>({ [SCOPE]: true });
  SCOPES.set(scope, {
    cohort,
    sources,
    owner: Object.freeze({ identity: Symbol('registration owner') }),
    fingerprint: fingerprint(sources),
    indexes: new Map(),
  });
  return scope;
}
function grouped(
  values: readonly Callback[],
  input: RegistryInput,
  checks: GroupCheck[],
): readonly Callback[] {
  if (values.length === 1) return values;
  const state = scopeState(input);
  if (state === undefined) return refuse('duplicate module id across loaded chunks');
  const groupInput: NodeManifestRegistrationGroupInput = Object.freeze({
    owner: state.owner,
    cohort: state.cohort,
    runtime: input.runtime,
    sources: input.sources,
    occurrences: Object.freeze(
      values.map((value) => Object.freeze({ physical: value.physical, factory: value.factory })),
    ),
  });
  const proof = certifyNodeManifestRegistrationGroup(groupInput);
  const group = proof === undefined ? undefined : nodeManifestRegistrationGroup(proof, groupInput);
  if (group === undefined || proof === undefined)
    return refuse('uncertified duplicate module registration');
  checks.push({ proof, input: groupInput });
  return values.map((value) => {
    const current = group.occurrences.find((member) => member.physicalId === value.physical.id);
    if (
      current === undefined ||
      JSON.stringify(current.projections) !== JSON.stringify(value.projections)
    )
      return refuse('registration projection disagreement');
    return { ...value, projections: current.projections };
  });
}
function physicalId(physical: string, id: NodeManifestTurbopackModuleId, runtime?: string): string {
  return `${runtime === undefined ? physical : JSON.stringify([runtime, physical])}#${turbopackModuleSpecifier(id)}`;
}
function resolved(physical: NodeManifestTurbopackGraphFile, specifier: string): string {
  const targets = new Set(
    physical.imports.filter((edge) => edge.specifier === specifier).map((edge) => edge.target),
  );
  if (targets.size !== 1) return refuse('missing or ambiguous actual import edge');
  return targets.values().next().value ?? refuse('missing actual import target');
}
interface ViewBuilder {
  readonly input: RegistryInput;
  readonly records: NodeManifestRegistrationRecord[];
  readonly registrations: NodeManifestLogicalRegistration[];
  readonly rowIds: Set<string>;
  readonly sourceIds: ReadonlySet<string>;
}
function registerId(
  id: NodeManifestTurbopackModuleId,
  members: readonly Callback[],
  state: ViewBuilder,
): void {
  const { input } = state;
  const rows = members.map((member) =>
    physicalId(member.physical.id, id, input.cohort === undefined ? undefined : input.runtime.id),
  );
  const logical =
    rows.length === 1
      ? rows[0]
      : JSON.stringify([input.runtime.id, 'registration', turbopackModuleSpecifier(id)]);
  if (logical === undefined || state.sourceIds.has(logical))
    refuse('factory metadata identity collision');
  state.registrations.push(
    Object.freeze({ id: logical, moduleId: id, members: Object.freeze(rows) }),
  );
  for (const row of rows) {
    if (state.sourceIds.has(row) || state.rowIds.has(row))
      refuse('factory logical identity collision');
    state.rowIds.add(row);
  }
}
function registerCallbacks(members: readonly Callback[], state: ViewBuilder): void {
  const first = members[0];
  if (first === undefined) refuse('empty registration vector');
  for (const id of first.factory.ids) registerId(id, members, state);
  for (const member of members)
    for (const projection of member.projections)
      state.records.push(Object.freeze({ physical: member.physical, projection }));
}
function assertCompleteRecords(input: RegistryInput, state: ViewBuilder): void {
  const registered = new Set(state.registrations.map((registration) => registration.moduleId));
  assertTurbopackCacheOwners(state.records, registered);
  const factories = new Map<NodeManifestTurbopackModuleId, NodeManifestRegistrationRecord[]>();
  for (const record of state.records) {
    const members = factories.get(record.projection.moduleId) ?? [];
    members.push(record);
    factories.set(record.projection.moduleId, members);
  }
  assertTurbopackAsyncGraph({ distDir: input.distDir, tables: input.tables, factories });
}
function buildView(input: RegistryInput, checks: GroupCheck[]): NodeManifestRegistrationView {
  const vectors = completeVectors(callbacks(input.tables));
  const state: ViewBuilder = {
    input,
    records: [],
    registrations: [],
    rowIds: new Set(),
    sourceIds: new Set(input.sources.map((source) => source.id)),
  };
  for (const values of vectors.values()) registerCallbacks(grouped(values, input, checks), state);
  assertCompleteRecords(input, state);
  return finalizeView(input, state.records, state.registrations, state.rowIds);
}
function importedTarget(
  edge: NodeManifestTurbopackImport,
  physical: NodeManifestTurbopackGraphFile,
  targets: ReadonlyMap<NodeManifestTurbopackModuleId, string>,
): string {
  if (edge.targetId !== undefined)
    return targets.get(edge.targetId) ?? refuse('unregistered module dependency');
  return isBuiltin(edge.specifier) ? edge.specifier : resolved(physical, edge.specifier);
}
function factoryRow(
  input: RegistryInput,
  record: NodeManifestRegistrationRecord,
  targets: ReadonlyMap<NodeManifestTurbopackModuleId, string>,
): NodeManifestTurbopackGraphFactory {
  const { physical, projection } = record;
  return Object.freeze({
    id: physicalId(
      physical.id,
      projection.moduleId,
      input.cohort === undefined ? undefined : input.runtime.id,
    ),
    runtimeId: input.runtime.id,
    physicalId: physical.id,
    projection,
    imports: Object.freeze(
      projection.imports.map((edge) => {
        return Object.freeze({
          specifier: edge.specifier,
          target: importedTarget(edge, physical, targets),
        });
      }),
    ),
  });
}
function finalizeView(
  input: RegistryInput,
  records: readonly NodeManifestRegistrationRecord[],
  registrations: readonly NodeManifestLogicalRegistration[],
  rowIds: ReadonlySet<string>,
): NodeManifestRegistrationView {
  const targets = new Map(
    registrations.map((registration) => [registration.moduleId, registration.id] as const),
  );
  const logical = new Set<string>();
  for (const registration of registrations) {
    if (
      logical.has(registration.id) ||
      (registration.members.length > 1 && rowIds.has(registration.id))
    )
      refuse('factory logical identity collision');
    logical.add(registration.id);
  }
  const rows = records.map((record) => factoryRow(input, record, targets));
  return Object.freeze({
    runtimeId: input.runtime.id,
    rows: Object.freeze(rows),
    records: Object.freeze(records),
    registrations: Object.freeze(registrations),
  });
}
function checked(
  index: NodeManifestRegistrationIndex,
  sources: RegistryInput['sources'],
): IndexState {
  const state = INDEXES.get(index);
  if (
    state === undefined ||
    state.sources !== sources ||
    state.fingerprint !== fingerprint(sources) ||
    state.viewFingerprint !== fingerprint(state.view) ||
    state.tables.length !== state.input.tables.length ||
    state.tables.some((table, offset) => table !== state.input.tables[offset])
  )
    return refuse('stale registration index');
  scopeState(state.input);
  for (const group of state.groups)
    if (nodeManifestRegistrationGroup(group.proof, group.input) === undefined)
      refuse('stale registration group');
  return state;
}
export function nodeManifestRegistrationIndex(input: RegistryInput): NodeManifestRegistrationIndex {
  const scope = scopeState(input);
  const previous = scope?.indexes.get(input.runtime.id);
  if (previous !== undefined) {
    const known = checked(previous, input.sources);
    if (
      known.runtime !== input.runtime ||
      path.resolve(known.input.distDir) !== path.resolve(input.distDir) ||
      known.tables.length !== input.tables.length ||
      known.tables.some((table, index) => table !== input.tables[index])
    )
      refuse('registration installation changed');
    return previous;
  }
  const groups: GroupCheck[] = [];
  const view = buildView(input, groups);
  assertInstallation(input);
  const index = Object.freeze<NodeManifestRegistrationIndex>({ [INDEX]: true });
  INDEXES.set(index, {
    input: Object.freeze({ ...input }),
    runtime: input.runtime,
    sources: input.sources,
    tables: Object.freeze([...input.tables]),
    fingerprint: fingerprint(input.sources),
    groups: Object.freeze(groups),
    view,
    viewFingerprint: fingerprint(view),
  });
  scope?.indexes.set(input.runtime.id, index);
  return index;
}
export function nodeManifestRegistrationView(
  index: NodeManifestRegistrationIndex,
  sources: RegistryInput['sources'],
): NodeManifestRegistrationView {
  return checked(index, sources).view;
}
export function nodeManifestInitialRegistration(
  index: NodeManifestRegistrationIndex,
  sources: RegistryInput['sources'],
  id: NodeManifestTurbopackModuleId,
  initialChunks: ReadonlySet<string>,
): string {
  const view = nodeManifestRegistrationView(index, sources);
  const registration = view.registrations.find((item) => item.moduleId === id);
  if (
    registration === undefined ||
    view.rows.every(
      (row) => !registration.members.includes(row.id) || !initialChunks.has(row.physicalId),
    )
  )
    return refuse('entry module is not initially registered');
  return registration.id;
}
