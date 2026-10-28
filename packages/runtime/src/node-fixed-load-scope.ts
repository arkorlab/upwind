type ObjectValue = Record<PropertyKey, unknown>;
export interface NodeFixedLoadSource {
  readonly filename: string;
  readonly directory: string;
  readonly requests: readonly string[];
}
export interface NodeFixedLoadScopeInput {
  readonly sources: readonly NodeFixedLoadSource[];
  readonly isProxy: (value: unknown) => boolean;
}
const descriptorOf = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const NativeError = Error;
const NativeMap = Map;
const NativeSet = Set;
const SCOPE = Symbol('fixed Node load history scope');
const LEASE = Symbol('fixed Node source evaluation lease');
export interface NodeFixedLoadScope {
  readonly [SCOPE]: true;
}
export interface NodeFixedLoadLease {
  readonly [LEASE]: true;
}
interface Source {
  readonly filename: string;
  readonly hasRequest: (request: string) => boolean;
}
interface State {
  readonly isProxy: NodeFixedLoadScopeInput['isProxy'];
  readonly hasRequest: (request: string) => boolean;
  readonly byFilename: (filename: string) => Source | undefined;
  readonly byDirectory: (directory: string) => Source | undefined;
  active: LeaseState | undefined;
}
interface LeaseState {
  readonly scope: State;
  readonly source: Source;
  readonly receiver: ObjectValue;
  fault: Error | undefined;
  closed: boolean;
}
const scopes = new WeakMap<NodeFixedLoadScope, State>();
const leases = new WeakMap<NodeFixedLoadLease, LeaseState>();
const getScope = scopes.get.bind(scopes);
const setScope = scopes.set.bind(scopes);
const getLease = leases.get.bind(leases);
const setLease = leases.set.bind(leases);
function standalone(reason: string): never {
  throw new NativeError(`Unsupported fixed Node load scope: ${reason}`);
}
function stateOf(scope: NodeFixedLoadScope): State {
  return getScope(scope) ?? standalone('copied or missing private scope');
}
function fault(state: State, reason: string, cause?: unknown): Error {
  const active = state.active;
  const previous = active?.fault;
  if (previous !== undefined) return previous;
  const failure = new NativeError(`Unsupported fixed Node load scope: ${reason}`, { cause });
  if (active !== undefined) active.fault = failure;
  return failure;
}
function refuse(state: State, reason: string): never {
  throw fault(state, reason);
}
function object(value: unknown): value is ObjectValue {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
function checkedParent(state: State, parent: unknown): ObjectValue {
  if (!object(parent) || state.isProxy(parent)) refuse(state, 'proxy or non-object load parent');
  return parent;
}
function directoryOf(state: State, parent: ObjectValue): string {
  const descriptor = descriptorOf(parent, 'path');
  const value: unknown = descriptor?.value;
  if (descriptor === undefined || typeof value !== 'string' || !hasOwn(descriptor, 'value'))
    refuse(state, 'load parent requires own DATA string path');
  return value;
}
function activeLease(state: State, lease: NodeFixedLoadLease): LeaseState {
  const actual = getLease(lease) ?? refuse(state, 'foreign, closed or inactive evaluation lease');
  if (actual.scope !== state || actual.closed || state.active !== actual)
    refuse(state, 'foreign, closed or inactive evaluation lease');
  return actual;
}

/** Trusted bootstrap must install its transparent _load fence before any application loads. */
export function createNodeFixedLoadScope(input: NodeFixedLoadScopeInput): NodeFixedLoadScope {
  const byFilename = new NativeMap<string, Source>();
  const byDirectory = new NativeMap<string, Source>();
  const allRequests = new NativeSet<string>();
  for (const source of input.sources) {
    if (
      typeof source.filename !== 'string' ||
      typeof source.directory !== 'string' ||
      source.filename === '' ||
      source.directory === '' ||
      byFilename.has(source.filename) ||
      byDirectory.has(source.directory)
    )
      standalone('duplicate or invalid fixed source coordinate');
    const requests = new NativeSet<string>();
    for (const request of source.requests) {
      if (typeof request !== 'string' || request === '' || requests.has(request))
        standalone('duplicate or invalid fixed literal request');
      requests.add(request);
      allRequests.add(request);
    }
    if (requests.size === 0) standalone('fixed source has no physical requests');
    const known = freeze({ filename: source.filename, hasRequest: requests.has.bind(requests) });
    byFilename.set(source.filename, known);
    byDirectory.set(source.directory, known);
  }
  const scope = freeze<NodeFixedLoadScope>({ [SCOPE]: true });
  setScope(scope, {
    isProxy: input.isProxy,
    hasRequest: allRequests.has.bind(allRequests),
    byFilename: byFilename.get.bind(byFilename),
    byDirectory: byDirectory.get.bind(byDirectory),
    active: undefined,
  });
  return scope;
}

/** Root first checks the exact source, realm and default Module receiver; no filename authority. */
export function enterNodeFixedLoadScope(
  scope: NodeFixedLoadScope,
  filename: string,
  receiver: unknown,
): NodeFixedLoadLease | undefined {
  const state = stateOf(scope);
  const source = state.byFilename(filename);
  if (source === undefined) return undefined;
  if (state.active !== undefined) refuse(state, 'overlapping fixed source evaluation');
  const actual = checkedParent(state, receiver);
  const lease = freeze<NodeFixedLoadLease>({ [LEASE]: true });
  const row: LeaseState = {
    scope: state,
    source,
    receiver: actual,
    fault: undefined,
    closed: false,
  };
  state.active = row;
  setLease(lease, row);
  return lease;
}

/** Inspect only the literal cache keys being fenced, without ordinary parent.path lookup. */
export function assertNodeFixedLoadScope(
  scope: NodeFixedLoadScope,
  request: unknown,
  parent: unknown,
): Readonly<{ filename: string }> | undefined {
  const state = stateOf(scope);
  if (typeof request !== 'string' || !state.hasRequest(request)) return undefined;
  // The fixed Node loader cannot form a relativeResolveCache parent-path key without a parent.
  if (parent === undefined || parent === null) return undefined;
  const actual = checkedParent(state, parent);
  const source = state.byDirectory(directoryOf(state, actual));
  if (source?.hasRequest(request) !== true) return undefined;
  const active =
    state.active ?? refuse(state, 'fixed-directory load outside actual evaluation receiver');
  if (active.source !== source || active.receiver !== actual)
    refuse(state, 'fixed-directory load outside actual evaluation receiver');
  if (active.fault !== undefined) throw active.fault;
  return freeze({ filename: source.filename });
}

/** Keep the first failure sticky even when an original vendor try/catch handles the thrown error. */
export function poisonNodeFixedLoadScope(
  scope: NodeFixedLoadScope,
  filename: string,
  error: unknown,
): void {
  const state = stateOf(scope);
  const active = state.active;
  if (active === undefined) return;
  if (active.source.filename !== filename) refuse(state, 'failure for another active source');
  fault(state, 'guarded load failed', error);
}

/** Root calls after original _compile returns, outside the original WS fallback catch. */
export function assertNodeFixedLoadScopeHealthy(
  scope: NodeFixedLoadScope,
  lease: NodeFixedLoadLease,
): void {
  const active = activeLease(stateOf(scope), lease);
  if (active.fault !== undefined) throw active.fault;
}

/** Always called from the wrapper's finally, including a poisoned or throwing evaluation. */
export function leaveNodeFixedLoadScope(
  scope: NodeFixedLoadScope,
  lease: NodeFixedLoadLease,
): void {
  const state = stateOf(scope);
  const active = activeLease(state, lease);
  active.closed = true;
  state.active = undefined;
}
