/** DATA identity guard only. Trusted pre-app bootstrap independently qualifies source and paths. */
export interface NodeNextHookMapInput {
  readonly map: unknown;
  readonly expected: readonly (readonly [request: string, target: string])[];
  readonly isProxy: (value: unknown) => boolean;
}
type ObjectValue = Record<PropertyKey, unknown>;
const NativeError = Error;
const CHANGED_INVENTORY = 'changed alias inventory';
const GUARD = Symbol('fixed Next hook alias Map');
export interface NodeNextHookMap {
  readonly [GUARD]: true;
}
const descriptorOf = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const apply = Reflect.apply;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const isArray = Array.isArray;
const arrayPrototype = Array.prototype;
const mapPrototype = Map.prototype;
const getDescriptor = requiredDescriptor(mapPrototype, 'get');
const entriesDescriptor = requiredDescriptor(mapPrototype, 'entries');
const sizeDescriptor = requiredDescriptor(mapPrototype, 'size');
const mapGet = method(getDescriptor) as typeof Map.prototype.get;
const mapEntries = method(entriesDescriptor) as typeof Map.prototype.entries;
const mapSize: unknown = descriptorOf(sizeDescriptor, 'get')?.value;
// This iterator is created from a trusted intrinsic before app code, never from the input Map.
const iterator = new Map<string, string>().entries();
const iteratorPrototype: unknown = prototypeOf(iterator);
const nextDescriptor = requiredDescriptor(iteratorPrototype, 'next');
const iteratorNext = method(nextDescriptor) as MapIterator<[string, string]>['next'];
const REQUESTS = freeze(['styled-jsx', 'styled-jsx/style', 'styled-jsx/style.js']);
type Entry = readonly [request: string, target: string];
interface State {
  readonly map: ObjectValue;
  readonly expected: readonly Entry[];
  readonly isProxy: NodeNextHookMapInput['isProxy'];
}
const guards = new WeakMap<NodeNextHookMap, State>();
const getGuard = guards.get.bind(guards);
const setGuard = guards.set.bind(guards);
function fail(reason: string): never {
  throw new NativeError(`Unsupported Next hook alias Map: ${reason}`);
}
function object(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null;
}
function requiredDescriptor(owner: unknown, key: PropertyKey): PropertyDescriptor {
  const descriptor = descriptorOf(owner, key);
  if (descriptor === undefined) fail('missing intrinsic descriptor');
  return freeze(descriptor);
}
function method(descriptor: PropertyDescriptor): unknown {
  const value: unknown = descriptor.value;
  if (typeof value !== 'function' || !hasOwn(descriptor, 'value')) fail('non-function intrinsic');
  return value;
}
function data(owner: ObjectValue, key: PropertyKey): unknown {
  const descriptor = descriptorOf(owner, key);
  if (descriptor === undefined || !hasOwn(descriptor, 'value')) fail('required own DATA');
  const value: unknown = descriptor.value;
  return value;
}
function sameDescriptor(actual: PropertyDescriptor | undefined, expected: PropertyDescriptor) {
  if (
    actual === undefined ||
    actual.configurable !== expected.configurable ||
    actual.enumerable !== expected.enumerable ||
    hasOwn(actual, 'value') !== hasOwn(expected, 'value')
  )
    return false;
  return hasOwn(expected, 'value')
    ? actual.writable === expected.writable && actual.value === expected.value
    : actual.get === expected.get && actual.set === expected.set;
}
function intrinsics(): void {
  if (
    !sameDescriptor(descriptorOf(mapPrototype, 'get'), getDescriptor) ||
    !sameDescriptor(descriptorOf(mapPrototype, 'entries'), entriesDescriptor) ||
    !sameDescriptor(descriptorOf(mapPrototype, 'size'), sizeDescriptor) ||
    !sameDescriptor(descriptorOf(iteratorPrototype, 'next'), nextDescriptor)
  )
    fail('changed Map or iterator intrinsics');
}
function denseArray(value: ObjectValue, length: number): void {
  if (
    !isArray(value) ||
    prototypeOf(value) !== arrayPrototype ||
    data(value, 'length') !== length ||
    ownKeys(value).length !== length + 1
  )
    fail('expected plain dense DATA array');
}
function array(value: unknown, isProxy: State['isProxy'], length: number): ObjectValue {
  if (!object(value) || isProxy(value)) fail('expected plain dense DATA array');
  denseArray(value, length);
  return value;
}
function expectedEntries(input: NodeNextHookMapInput): readonly Entry[] {
  const value: unknown = input.expected;
  if (!object(value) || input.isProxy(value)) fail('expected plain DATA inventory');
  const length = data(value, 'length');
  if (typeof length !== 'number' || length < 0 || length > REQUESTS.length || length % 1 !== 0)
    fail('expected zero to three fixed aliases');
  array(value, input.isProxy, length);
  const entries: Entry[] = [];
  for (let index = 0; index < length; index += 1) {
    const pair = array(data(value, String(index)), input.isProxy, 2);
    const request = data(pair, '0');
    const target = data(pair, '1');
    if (
      typeof request !== 'string' ||
      typeof target !== 'string' ||
      target === '' ||
      (request !== REQUESTS[0] && request !== REQUESTS[1] && request !== REQUESTS[2])
    )
      fail('unknown alias or non-string target');
    for (let previous = 0; previous < index; previous += 1)
      if (entries[previous]?.[0] === request) fail('duplicate fixed alias');
    entries.push(freeze<Entry>([request, target]));
  }
  return freeze(entries);
}
function next(current: ObjectValue): ObjectValue {
  const step: unknown = apply(iteratorNext, current, []);
  if (!object(step)) fail('non-default iterator result');
  return step;
}
function entry(state: State, current: ObjectValue, index: number): void {
  const step = next(current);
  if (data(step, 'done') !== false) fail(CHANGED_INVENTORY);
  const values = array(data(step, 'value'), state.isProxy, 2);
  const expected = state.expected[index];
  if (expected === undefined) fail(CHANGED_INVENTORY);
  const actual: unknown = apply(mapGet, state.map, [expected[0]]);
  if (
    data(values, '0') !== expected[0] ||
    data(values, '1') !== expected[1] ||
    actual !== expected[1]
  )
    fail(CHANGED_INVENTORY);
}
function inventory(state: State, value: unknown): void {
  if (
    value !== state.map ||
    state.isProxy(value) ||
    prototypeOf(state.map) !== mapPrototype ||
    ownKeys(state.map).length > 0
  )
    fail('different, proxy, non-default or overridden Map');
  intrinsics();
  if (typeof mapSize !== 'function') fail('missing intrinsic size getter');
  try {
    const size: unknown = apply(mapSize, state.map, []);
    if (size !== state.expected.length) fail(CHANGED_INVENTORY);
    const current: unknown = apply(mapEntries, state.map, []);
    if (!object(current) || prototypeOf(current) !== iteratorPrototype)
      fail('non-default Map iterator');
    for (let index = 0; index < state.expected.length; index += 1) entry(state, current, index);
    if (data(next(current), 'done') !== true) fail(CHANGED_INVENTORY);
  } catch {
    fail('invalid Map brand or alias inventory');
  }
}

/** Expected strings are copied privately; neither a token nor a match grants loader permission. */
export function captureNodeNextHookMap(input: NodeNextHookMapInput): NodeNextHookMap {
  intrinsics();
  if (!object(input.map) || input.isProxy(input.map)) fail('proxy or non-object Map');
  const state = freeze({
    map: input.map,
    expected: expectedEntries(input),
    isProxy: input.isProxy,
  });
  inventory(state, input.map);
  const guard = freeze<NodeNextHookMap>({ [GUARD]: true });
  setGuard(guard, state);
  return guard;
}

/** Recheck immediately before guarded use. Object.freeze(Map) does not freeze Map entries. */
export function assertNodeNextHookMap(guard: NodeNextHookMap, map: unknown): void {
  const state = getGuard(guard) ?? fail('copied or missing private guard');
  inventory(state, map);
}
