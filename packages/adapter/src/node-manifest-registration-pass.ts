import { AuditError } from './dependencies.ts';
import {
  assertNodeManifestRegistrationViews,
  nodeManifestRegistrationSnapshot,
  type NodeManifestRegistrationViews,
  type NodeManifestRegistrationSnapshot,
} from './node-manifest-registration-views.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';
import type { NodeManifestTurbopackModuleId } from './node-manifest-turbopack.ts';

export interface NodeManifestRegistrationPass {
  readonly kind: 'scoped runtime registration pass';
}
interface State {
  active: boolean;
  readonly proof: NodeManifestRegistrationViews;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly members: ReadonlyMap<string, readonly string[]>;
  readonly grouped: ReadonlySet<string>;
  readonly rows: ReadonlySet<NodeManifestTurbopackGraphFactory>;
  readonly forwarded: ReadonlyMap<string, NodeManifestRegistrationSnapshot['forwarded'][number]>;
  readonly boots: ReadonlyMap<
    NodeManifestTurbopackBootGraph,
    ReadonlyMap<
      NodeManifestTurbopackModuleId,
      NodeManifestRegistrationSnapshot['boots'][number]['registrations'][number]
    >
  >;
}
const PASSES = new WeakMap<NodeManifestRegistrationPass, State>();
function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js registration pass ${reason}; refusing native publication`);
}
function stateOf(pass: NodeManifestRegistrationPass): State {
  const state = PASSES.get(pass);
  if (state?.active !== true) return refuse('inactive or uncertified scope');
  return state;
}
function begin(proof: NodeManifestRegistrationViews): NodeManifestRegistrationPass {
  const snapshot = nodeManifestRegistrationSnapshot(proof);
  const pass = Object.freeze<NodeManifestRegistrationPass>({
    kind: 'scoped runtime registration pass',
  });
  PASSES.set(pass, {
    active: true,
    proof,
    sources: snapshot.sources,
    members: new Map(snapshot.members),
    grouped: new Set(snapshot.grouped),
    rows: new Set(snapshot.rowPointers),
    forwarded: new Map(snapshot.forwarded.map((entry) => [entry.id, entry])),
    boots: new Map(
      snapshot.boots.map((boot) => {
        const registrations = new Map(boot.registrations.map((entry) => [entry.moduleId, entry]));
        return [boot.graph, registrations] as const;
      }),
    ),
  });
  return pass;
}
function revoke(pass: NodeManifestRegistrationPass): void {
  const state = PASSES.get(pass);
  if (state !== undefined) state.active = false;
}
function finish(pass: NodeManifestRegistrationPass): void {
  assertNodeManifestRegistrationViews(stateOf(pass).proof);
}
export function assertNodeManifestPassBinding(
  pass: NodeManifestRegistrationPass,
  proof: NodeManifestRegistrationViews | undefined,
): void {
  if (stateOf(pass).proof !== proof) refuse('foreign registration views');
}
export function assertNodeManifestPassSources(
  pass: NodeManifestRegistrationPass,
  sources: readonly NodeManifestTurbopackGraphFile[],
): void {
  if (stateOf(pass).sources !== sources) refuse('foreign source array');
}
/** The result leaves this scope only after every original index and boot is revalidated. */
export function withNodeManifestRegistrationPass<T>(
  proof: NodeManifestRegistrationViews,
  use: (pass: NodeManifestRegistrationPass) => T,
): T {
  const pass = begin(proof);
  try {
    const result = use(pass);
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result
    )
      refuse('asynchronous result in synchronous scope');
    finish(pass);
    return result;
  } finally {
    revoke(pass);
  }
}
/** No async result or provisional proof escapes before final freshness validation. */
export async function withNodeManifestRegistrationPassAsync<T>(
  proof: NodeManifestRegistrationViews,
  use: (pass: NodeManifestRegistrationPass) => Promise<T>,
): Promise<T> {
  const pass = begin(proof);
  try {
    const result = await use(pass);
    finish(pass);
    return result;
  } finally {
    revoke(pass);
  }
}
export function nodeManifestPassMembers(
  pass: NodeManifestRegistrationPass,
  id: string,
): readonly string[] | undefined {
  return stateOf(pass).members.get(id);
}
export function assertNodeManifestPassSingle(pass: NodeManifestRegistrationPass, id: string): void {
  if (stateOf(pass).grouped.has(id)) refuse('grouped protected identity unsupported');
}
export function assertNodeManifestPassRows(
  pass: NodeManifestRegistrationPass,
  rows: readonly NodeManifestTurbopackGraphFactory[],
): void {
  const expected = stateOf(pass).rows;
  if (
    rows.length !== expected.size ||
    new Set(rows).size !== expected.size ||
    rows.some((row) => !expected.has(row))
  )
    refuse('incomplete physical rows');
}
export function nodeManifestPassForwarded(
  pass: NodeManifestRegistrationPass,
  id: string,
): string | undefined {
  const value = stateOf(pass).forwarded.get(id);
  if (value?.error !== undefined) throw new AuditError(value.error);
  return value?.target;
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
    const forwarded = state.forwarded.get(member);
    if (forwarded?.error !== undefined) throw new AuditError(forwarded.error);
    if (forwarded?.target !== undefined) targets.push(forwarded.target);
  }
  return { protected: false, targets };
}
export function nodeManifestPassTouchesProtected(
  pass: NodeManifestRegistrationPass,
  id: string,
  complete: ReadonlyMap<string, unknown>,
): boolean {
  const state = stateOf(pass);
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
export function nodeManifestPassInitial(
  pass: NodeManifestRegistrationPass,
  graph: NodeManifestTurbopackBootGraph,
  id: NodeManifestTurbopackModuleId,
  chunks: ReadonlySet<string>,
): string {
  const entry = stateOf(pass).boots.get(graph)?.get(id);
  if (entry === undefined || entry.physicalIds.every((physical) => !chunks.has(physical)))
    return refuse('unregistered boot evaluation');
  return entry.id;
}
