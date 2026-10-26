import { AuditError } from './dependencies.ts';
import {
  nodeManifestInitialRegistration,
  nodeManifestRegistrationView,
  type NodeManifestRegistrationView,
} from './node-manifest-registration-registry.ts';
import type { NodeManifestRuntimeCallerProof } from './node-manifest-runtime-callers.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';
import { forwarded } from './node-manifest-turbopack-parents.ts';
import type { NodeManifestTurbopackModuleId } from './node-manifest-turbopack.ts';

export interface NodeManifestRegistrationViews {
  readonly kind: 'runtime registration views';
}
interface Snapshot {
  readonly graph: NodeManifestTurbopackBootGraph;
  readonly runtimeId: string;
  readonly index: NodeManifestTurbopackBootGraph['registrationIndex'];
  readonly rows: readonly NodeManifestTurbopackGraphFactory[];
  readonly rowPointers: readonly NodeManifestTurbopackGraphFactory[];
  readonly legacyFingerprint: string | undefined;
  readonly graphIdentity: string;
}
interface State {
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly snapshots: readonly Snapshot[];
  readonly members: ReadonlyMap<string, readonly string[]>;
  readonly rows: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>;
  readonly grouped: ReadonlySet<string>;
}
const VIEWS = new WeakMap<NodeManifestRegistrationViews, State>();
interface Builder {
  readonly members: Map<string, readonly string[]>;
  readonly grouped: Set<string>;
  readonly rows: Map<string, NodeManifestTurbopackGraphFactory>;
}

function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js registration view ${reason}; refusing native publication`);
}

function legacyRegistrations(
  graph: NodeManifestTurbopackBootGraph,
): NodeManifestRegistrationView['registrations'] {
  const ids = new Set<NodeManifestTurbopackModuleId>();
  return graph.factories.map((factory) => {
    const id = factory.projection.moduleId;
    if (ids.has(id)) refuse('duplicate legacy module id');
    ids.add(id);
    return { id: factory.id, moduleId: id, members: [factory.id] };
  });
}

function graphView(
  graph: NodeManifestTurbopackBootGraph,
  sources: State['sources'],
): NodeManifestRegistrationView | undefined {
  if (sources.find((source) => source.id === graph.runtimeId) !== graph.runtime)
    refuse('runtime source binding');
  if (graph.registrationIndex === undefined) return undefined;
  const view = nodeManifestRegistrationView(graph.registrationIndex, sources);
  if (view.runtimeId !== graph.runtimeId || view.rows !== graph.factories)
    refuse('graph/index binding');
  return view;
}

function graphIdentity(graph: Snapshot['graph']): string {
  return JSON.stringify([
    graph.physicalId,
    graph.exportedId,
    graph.evaluations,
    graph.initialChunks,
    graph.lookupTables,
  ]);
}

function checked(proof: NodeManifestRegistrationViews): State {
  const state = VIEWS.get(proof);
  if (state === undefined) return refuse('uncertified views');
  for (const snapshot of state.snapshots) {
    const graph = snapshot.graph;
    if (
      graph.runtimeId !== snapshot.runtimeId ||
      graph.registrationIndex !== snapshot.index ||
      graph.factories !== snapshot.rows ||
      graph.factories.length !== snapshot.rowPointers.length ||
      graph.factories.some((row, index) => row !== snapshot.rowPointers[index]) ||
      graphIdentity(graph) !== snapshot.graphIdentity
    )
      refuse('stale graph identity');
    const view = graphView(graph, state.sources);
    if (view === undefined && JSON.stringify(graph.factories) !== snapshot.legacyFingerprint)
      refuse('stale legacy rows');
  }
  return state;
}

function mintSnapshot(
  graph: Snapshot['graph'],
  view: NodeManifestRegistrationView | undefined,
): Snapshot {
  return {
    graph,
    runtimeId: graph.runtimeId,
    index: graph.registrationIndex,
    rows: graph.factories,
    rowPointers: [...graph.factories],
    legacyFingerprint: view === undefined ? JSON.stringify(graph.factories) : undefined,
    graphIdentity: graphIdentity(graph),
  };
}

function addRows(graph: Snapshot['graph'], state: Builder): void {
  for (const factory of graph.factories) {
    const previous = state.rows.get(factory.id);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(factory))
      refuse('ambiguous physical row');
    state.rows.set(factory.id, factory);
  }
}

function addRegistrations(
  registrations: NodeManifestRegistrationView['registrations'],
  state: Builder,
): void {
  for (const registration of registrations) {
    const aliases = Object.freeze([...registration.members]);
    const ids = [registration.id, ...registration.members];
    for (const id of ids) {
      const previous = state.members.get(id);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(aliases))
        refuse('ambiguous logical members');
      state.members.set(id, aliases);
      if (aliases.length > 1) state.grouped.add(id);
    }
  }
}

/** No representative source exists: each logical lookup expands to every physical selected-ID row. */
export function createNodeManifestRegistrationViews(
  graphs: readonly NodeManifestTurbopackBootGraph[],
  sources: State['sources'],
): NodeManifestRegistrationViews {
  const members = new Map<string, readonly string[]>();
  const grouped = new Set<string>();
  const rows = new Map<string, NodeManifestTurbopackGraphFactory>();
  const runtimes = new Map<string, NodeManifestTurbopackBootGraph['registrationIndex']>();
  const snapshots: Snapshot[] = [];
  for (const graph of graphs) {
    if (runtimes.has(graph.runtimeId) && runtimes.get(graph.runtimeId) !== graph.registrationIndex)
      refuse('mixed runtime indexes');
    runtimes.set(graph.runtimeId, graph.registrationIndex);
    const view = graphView(graph, sources);
    snapshots.push(mintSnapshot(graph, view));
    addRows(graph, { members, grouped, rows });
    addRegistrations(view?.registrations ?? legacyRegistrations(graph), { members, grouped, rows });
  }
  const proof = Object.freeze<NodeManifestRegistrationViews>({
    kind: 'runtime registration views',
  });
  VIEWS.set(proof, { sources, snapshots, members, rows, grouped });
  return proof;
}

export function nodeManifestRegistrationMembers(
  proof: NodeManifestRegistrationViews,
  id: string,
): readonly string[] | undefined {
  return checked(proof).members.get(id);
}

/** All physical inputs must be present before reachability can filter protected incoming edges. */
export function assertNodeManifestRegistrationRows(
  proof: NodeManifestRegistrationViews,
  factories: readonly NodeManifestTurbopackGraphFactory[],
): void {
  const state = checked(proof);
  if (
    factories.length !== state.rows.size ||
    factories.some((factory) => state.rows.get(factory.id) !== factory)
  )
    refuse('incomplete physical rows');
}

/** Stage one groups prove ordinary equality only, never a protected/template/descriptor role. */
export function assertNodeManifestSingleRegistration(
  proof: NodeManifestRegistrationViews,
  id: string,
): void {
  if (checked(proof).grouped.has(id)) refuse('grouped protected identity unsupported');
}

function registrationTargets(
  state: State,
  id: string,
  complete: ReadonlyMap<string, unknown>,
): { readonly protected: boolean; readonly targets: readonly string[] } {
  const targets: string[] = [];
  const members = state.members.get(id) ?? [id];
  for (const member of members) {
    if (complete.has(member)) return { protected: true, targets };
    const factory = state.rows.get(member);
    const next = factory === undefined ? undefined : forwarded(factory);
    if (next !== undefined) targets.push(next);
  }
  return { protected: false, targets };
}

/** Additional ordinary boots may touch a group, but cannot borrow any protected chain through it. */
export function nodeManifestRegistrationTouchesProtected(
  proof: NodeManifestRegistrationViews,
  id: string,
  complete: ReadonlyMap<string, unknown>,
): boolean {
  const state = checked(proof);
  const active = new Set<string>();
  const completed = new Set<string>();
  const pending = [{ id, exit: false }];
  for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
    const target = frame.id;
    if (frame.exit) {
      active.delete(target);
      completed.add(target);
      continue;
    }
    if (completed.has(target)) continue;
    if (active.has(target)) refuse('cyclic namespace forwarding');
    active.add(target);
    pending.push({ id: target, exit: true });
    const next = registrationTargets(state, target, complete);
    if (next.protected) return true;
    for (const child of next.targets) pending.push({ id: child, exit: false });
  }
  return false;
}

export function nodeManifestInitialGraphRegistration(
  graph: NodeManifestTurbopackBootGraph,
  sources: State['sources'],
  id: NodeManifestTurbopackModuleId,
  initialChunks: ReadonlySet<string>,
): string {
  const view = graphView(graph, sources);
  if (view !== undefined && graph.registrationIndex !== undefined) {
    const registration = view.registrations.find((entry) => entry.moduleId === id);
    if (
      registration === undefined ||
      view.rows.every(
        (row) => !registration.members.includes(row.id) || !initialChunks.has(row.physicalId),
      )
    )
      refuse('unregistered boot evaluation');
    return nodeManifestInitialRegistration(graph.registrationIndex, sources, id, initialChunks);
  }
  legacyRegistrations(graph);
  const factory = graph.factories.find((row) => row.projection.moduleId === id);
  if (factory === undefined || !initialChunks.has(factory.physicalId))
    refuse('unregistered boot evaluation');
  return factory.id;
}

export function nodeManifestConsumerBoots(
  graphs: readonly NodeManifestTurbopackBootGraph[],
  proof: NodeManifestRuntimeCallerProof | undefined,
): ReadonlySet<string> {
  const boots = new Set(graphs.map((graph) => graph.physicalId));
  if (proof !== undefined) for (const caller of proof.callers) boots.add(caller.id);
  return boots;
}

/** Preserve every actual table/runtime/caller file; logical group IDs never become proof sources. */
export function nodeManifestRegistrationProofFiles(
  graphs: readonly NodeManifestTurbopackBootGraph[],
  sources: State['sources'],
  proof: NodeManifestRuntimeCallerProof | undefined,
): readonly { readonly file: string; readonly sha256: string }[] {
  const files = new Map<string, { readonly file: string; readonly sha256: string }>();
  for (const graph of graphs) {
    const ids = new Set([graph.physicalId, graph.runtimeId]);
    for (const factory of graph.factories) ids.add(factory.physicalId);
    for (const source of sources)
      if (ids.has(source.id))
        files.set(source.file, { file: source.file, sha256: source.source.sha256 });
  }
  if (proof !== undefined)
    for (const caller of proof.callers)
      files.set(caller.file, { file: caller.file, sha256: caller.sha256 });
  return [...files.values()];
}
