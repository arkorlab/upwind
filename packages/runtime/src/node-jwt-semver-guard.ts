type ObjectValue = Record<PropertyKey, unknown>;
/** Supplied only by trusted bootstrap; the helper does not qualify source or a Module context. */
export interface NodeJwtSemverGuardInput {
  readonly filename: string;
  readonly isProxy: (value: unknown) => boolean;
  readonly cache: unknown;
}
const descriptorOf = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const sameValue = Object.is;
const objectPrototype = Object.prototype;
const NativeError = Error;
const GUARD = Symbol('genuine fixed JWT semver initialization');
const ABSENT = Symbol('no semver cache own property');
export interface NodeJwtSemverGuard {
  readonly [GUARD]: true;
}
interface Pending {
  readonly module: ObjectValue;
  readonly exports: ObjectValue;
}
interface Completed extends Pending {
  readonly esModule: PropertyDescriptor;
  readonly satisfies: PropertyDescriptor;
}
interface State {
  readonly filename: string;
  readonly isProxy: NodeJwtSemverGuardInput['isProxy'];
  readonly cache: ObjectValue;
  pending: Pending | undefined;
  completed: Completed | undefined;
}
const guards = new WeakMap<NodeJwtSemverGuard, State>();
const getGuard = guards.get.bind(guards);
const setGuard = guards.set.bind(guards);
function fail(reason: string): never {
  throw new NativeError(`Unsupported Node JWT semver state: ${reason}`);
}
function object(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null;
}
function checkedObject(state: Pick<State, 'isProxy'>, value: unknown): ObjectValue {
  if (!object(value) || state.isProxy(value)) fail('proxy or non-object');
  return value;
}
function data(owner: ObjectValue, key: PropertyKey): unknown {
  const descriptor = descriptorOf(owner, key);
  if (descriptor === undefined || !hasOwn(descriptor, 'value')) fail('required own DATA');
  const value: unknown = descriptor.value;
  return value;
}
function stateOf(guard: NodeJwtSemverGuard): State {
  return getGuard(guard) ?? fail('copied or missing private guard');
}
function cacheEntry(state: State): unknown {
  // Other cache entries remain mutable. Only this exact fixed source coordinate is inspected.
  checkedObject(state, state.cache);
  if (prototypeOf(state.cache) !== null) fail('changed default Module cache prototype');
  const descriptor = descriptorOf(state.cache, state.filename);
  if (descriptor === undefined) return ABSENT;
  if (!hasOwn(descriptor, 'value')) fail('semver cache accessor');
  const value: unknown = descriptor.value;
  return value;
}
function exportsObject(state: State, module: ObjectValue): ObjectValue {
  const value = checkedObject(state, data(module, 'exports'));
  if (prototypeOf(value) !== objectPrototype) fail('non-plain semver exports');
  return value;
}
function sameDescriptor(left: PropertyDescriptor | undefined, right: PropertyDescriptor): boolean {
  if (
    left === undefined ||
    left.configurable !== right.configurable ||
    left.enumerable !== right.enumerable ||
    hasOwn(left, 'value') !== hasOwn(right, 'value')
  )
    return false;
  return hasOwn(left, 'value')
    ? left.writable === right.writable && sameValue(left.value, right.value)
    : left.get === right.get && left.set === right.set;
}
function namespace(state: State, module: ObjectValue): Completed {
  const exports = exportsObject(state, module);
  const keys = ownKeys(exports);
  const esModule = descriptorOf(exports, '__esModule');
  const satisfies = descriptorOf(exports, 'satisfies');
  const getter: unknown =
    satisfies === undefined ? undefined : descriptorOf(satisfies, 'get')?.value;
  if (
    esModule === undefined ||
    satisfies === undefined ||
    typeof getter !== 'function' ||
    keys.length !== 2 ||
    keys[0] !== '__esModule' ||
    keys[1] !== 'satisfies' ||
    state.isProxy(getter) ||
    !hasOwn(esModule, 'value') ||
    esModule.value !== true ||
    esModule.writable !== false ||
    esModule.enumerable !== false ||
    esModule.configurable !== false ||
    hasOwn(satisfies, 'value') ||
    satisfies.set !== undefined ||
    satisfies.enumerable !== true ||
    satisfies.configurable !== false
  )
    fail('non-original semver namespace');
  return freeze({ module, exports, esModule: freeze(esModule), satisfies: freeze(satisfies) });
}

/** Install before app code. Successful raw _compile observation is required before a cache hit. */
export function createNodeJwtSemverGuard(input: NodeJwtSemverGuardInput): NodeJwtSemverGuard {
  if (typeof input.filename !== 'string' || input.filename === '') fail('missing semver filename');
  const cache = checkedObject(input, input.cache);
  const state: State = {
    filename: input.filename,
    isProxy: input.isProxy,
    cache,
    pending: undefined,
    completed: undefined,
  };
  if (cacheEntry(state) !== ABSENT) fail('semver cache populated before observation');
  const guard = freeze<NodeJwtSemverGuard>({ [GUARD]: true });
  setGuard(guard, state);
  return guard;
}

/** Called before each JWT evaluation; absence is allowed, an unobserved replacement is not. */
export function assertNodeJwtSemverCache(guard: NodeJwtSemverGuard): void {
  const state = stateOf(guard);
  if (state.pending !== undefined) fail('semver initialization incomplete');
  const cached = cacheEntry(state);
  if (cached === ABSENT) return;
  const known = state.completed;
  if (known === undefined || cached !== known.module) fail('unobserved semver cache module');
  const module = checkedObject(state, cached);
  if (data(module, 'loaded') !== true || exportsObject(state, module) !== known.exports)
    fail('changed semver Module exports or loaded state');
  const keys = ownKeys(known.exports);
  if (
    keys.length !== 2 ||
    keys[0] !== '__esModule' ||
    keys[1] !== 'satisfies' ||
    !sameDescriptor(descriptorOf(known.exports, '__esModule'), known.esModule) ||
    !sameDescriptor(descriptorOf(known.exports, 'satisfies'), known.satisfies)
  )
    fail('changed original semver namespace');
}

/** Root first validates exact source/realm/default Module context. No source runs in this helper. */
export function assertNodeJwtSemverStart(guard: NodeJwtSemverGuard, receiver: unknown): void {
  const state = stateOf(guard);
  if (state.pending !== undefined) fail('overlapping semver initialization');
  const module = checkedObject(state, receiver);
  if (
    cacheEntry(state) !== module ||
    data(module, 'filename') !== state.filename ||
    data(module, 'loaded') !== false
  )
    fail('non-default semver initialization Module');
  const exports = exportsObject(state, module);
  if (ownKeys(exports).length > 0) fail('semver requires original empty exports');
  state.pending = freeze({ module, exports });
}

/** Immediately after original _compile returns. Module.load sets loaded=true only afterward. */
export function rememberNodeJwtSemver(guard: NodeJwtSemverGuard, receiver: unknown): void {
  const state = stateOf(guard);
  const module = checkedObject(state, receiver);
  const pending = state.pending ?? fail('unobserved semver _compile completion');
  if (
    module !== pending.module ||
    cacheEntry(state) !== module ||
    data(module, 'filename') !== state.filename ||
    data(module, 'loaded') !== false
  )
    fail('unobserved semver _compile completion');
  const completed = namespace(state, module);
  if (completed.exports !== pending.exports) fail('replaced original semver exports');
  state.completed = completed;
  state.pending = undefined;
}
