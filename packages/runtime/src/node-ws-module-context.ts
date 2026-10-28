type ObjectValue = Record<PropertyKey, unknown>;
type NativeMethod = (this: unknown, ...args: unknown[]) => unknown;

/** Trusted-bootstrap evidence only; this does not qualify source or permit optional packages. */
export interface NodeWsModuleContextInput {
  readonly prototype: unknown;
  readonly isProxy: (value: unknown) => boolean;
  readonly parentDescriptor: PropertyDescriptor | undefined;
  readonly directory: string;
  readonly filename: string;
  readonly paths: readonly string[];
}

const descriptorOf = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const apply = Reflect.apply;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const sameValue = Object.is;
const arrayPrototype = Array.prototype;
const objectPrototype = Object.prototype;
const arrayIsArray = Array.isArray;
const stringify = String;
const NativeError = Error;
const NativeSet = Set;
const setHas: unknown = descriptorOf(Set.prototype, 'has')?.value;
const setAdd: unknown = descriptorOf(Set.prototype, 'add')?.value;
const CONTEXT = Symbol('fixed WS default CommonJS context');
export interface NodeWsModuleContext {
  readonly [CONTEXT]: true;
}
interface SymbolProperty {
  readonly key: symbol;
  readonly descriptor: PropertyDescriptor;
}
interface Prototype {
  readonly value: ObjectValue;
  readonly parent: ObjectValue | null;
  readonly symbols: readonly SymbolProperty[];
}
interface State {
  readonly prototype: ObjectValue;
  readonly isProxy: (value: unknown) => boolean;
  readonly parentDescriptor: PropertyDescriptor;
  readonly parentGetter: NativeMethod;
  readonly requireDescriptor: PropertyDescriptor;
  readonly prototypes: readonly Prototype[];
  readonly directory: string;
  readonly filename: string;
  readonly paths: readonly string[];
}
const contexts = new WeakMap<NodeWsModuleContext, State>();
const getContext = contexts.get.bind(contexts);
const setContext = contexts.set.bind(contexts);

function fail(reason: string): never {
  throw new NativeError(`Unsupported Node WebSocket module context: ${reason}`);
}
function object(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null;
}
function plainObject(value: unknown, isProxy: State['isProxy']): ObjectValue {
  if (!object(value) || isProxy(value)) fail('proxy or non-object Module receiver');
  return value;
}
function data(owner: ObjectValue, key: PropertyKey): unknown {
  const descriptor = descriptorOf(owner, key);
  if (descriptor === undefined || !hasOwn(descriptor, 'value')) fail('required own DATA property');
  const value: unknown = descriptor.value;
  return value;
}
function callable(value: unknown): value is NativeMethod {
  return typeof value === 'function';
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
function symbols(owner: ObjectValue): readonly SymbolProperty[] {
  const result: SymbolProperty[] = [];
  const keys = ownKeys(owner);
  let index = 0;
  while (index < keys.length) {
    const key = keys[index];
    index += 1;
    if (typeof key !== 'symbol') continue;
    const descriptor = descriptorOf(owner, key);
    if (descriptor === undefined || !hasOwn(descriptor, 'value'))
      fail('accessor in private Module parent lookup');
    result[result.length] = freeze({ key, descriptor: freeze(descriptor) });
  }
  return freeze(result);
}
function prototypeSymbols(prototype: ObjectValue, isProxy: State['isProxy']): readonly Prototype[] {
  const result: Prototype[] = [];
  for (let at: ObjectValue | null = prototype; at !== null;) {
    const value = plainObject(at, isProxy);
    const parent: unknown = prototypeOf(value);
    if (parent !== null && !object(parent)) fail('invalid Module prototype chain');
    result[result.length] = freeze({ value, parent, symbols: symbols(value) });
    at = parent;
  }
  return freeze(result);
}
function paths(value: unknown, isProxy: State['isProxy']): readonly string[] {
  const owner = plainObject(value, isProxy);
  if (!arrayIsArray(owner) || prototypeOf(owner) !== arrayPrototype)
    fail('non-default Module paths array');
  const length = data(owner, 'length');
  if (typeof length !== 'number' || ownKeys(owner).length !== length + 1)
    fail('non-dense Module paths array');
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = data(owner, stringify(index));
    if (typeof entry !== 'string') fail('non-string Module lookup path');
    result[index] = entry;
  }
  return freeze(result);
}
function checkPrototypes(state: State): void {
  if (
    !sameDescriptor(descriptorOf(state.prototype, 'parent'), state.parentDescriptor) ||
    !sameDescriptor(descriptorOf(state.prototype, 'require'), state.requireDescriptor)
  )
    fail('default Module loader descriptors changed');
  let at = 0;
  while (at < state.prototypes.length) {
    const known = state.prototypes[at] ?? fail('missing Module prototype snapshot');
    at += 1;
    if (state.isProxy(known.value) || prototypeOf(known.value) !== known.parent)
      fail('Module prototype chain changed');
    const current = symbols(known.value);
    if (current.length !== known.symbols.length) fail('Module prototype symbols changed');
    let index = 0;
    while (index < current.length) {
      const actual = current[index] ?? fail('missing current Module prototype symbol');
      const expected = known.symbols[index] ?? fail('missing Module prototype symbol');
      index += 1;
      if (actual.key !== expected.key || !sameDescriptor(actual.descriptor, expected.descriptor))
        fail('Module prototype symbol descriptor changed');
    }
  }
}

/** Capture before application code, from the actual default Module export and util.types. */
export function captureNodeWsModuleContext(input: NodeWsModuleContextInput): NodeWsModuleContext {
  const prototype = plainObject(input.prototype, input.isProxy);
  if (prototypeOf(prototype) !== objectPrototype) fail('non-default Module prototype');
  const parentDescriptor = descriptorOf(prototype, 'parent');
  const parentGetter: unknown =
    parentDescriptor === undefined ? undefined : descriptorOf(parentDescriptor, 'get')?.value;
  const requireDescriptor = descriptorOf(prototype, 'require');
  if (
    typeof input.directory !== 'string' ||
    typeof input.filename !== 'string' ||
    input.directory === '' ||
    input.filename === ''
  )
    fail('missing trusted Module coordinate');
  if (
    parentDescriptor === undefined ||
    requireDescriptor === undefined ||
    input.parentDescriptor === undefined ||
    typeof requireDescriptor.value !== 'function' ||
    hasOwn(parentDescriptor, 'value') ||
    !callable(parentGetter) ||
    !sameDescriptor(parentDescriptor, input.parentDescriptor) ||
    !hasOwn(requireDescriptor, 'value')
  )
    fail('missing trusted Module bootstrap basis');
  const context = freeze<NodeWsModuleContext>({ [CONTEXT]: true });
  setContext(
    context,
    freeze({
      prototype,
      isProxy: input.isProxy,
      parentDescriptor: freeze(parentDescriptor),
      parentGetter,
      requireDescriptor: freeze(requireDescriptor),
      prototypes: prototypeSymbols(prototype, input.isProxy),
      directory: input.directory,
      filename: input.filename,
      paths: paths(input.paths, input.isProxy),
    }),
  );
  return context;
}

function assertTarget(state: State, owner: ObjectValue): void {
  if (
    data(owner, 'filename') !== state.filename ||
    data(owner, 'id') !== state.filename ||
    data(owner, 'path') !== state.directory ||
    descriptorOf(owner, 'require') !== undefined
  )
    fail('changed qualified Module coordinate');
  const actual = paths(data(owner, 'paths'), state.isProxy);
  if (actual.length !== state.paths.length) fail('changed Module lookup paths');
  for (let index = 0; index < actual.length; index += 1)
    if (actual[index] !== state.paths[index]) fail('changed Module lookup path');
}

/** Validate immediately before original _compile, without reading application accessors. */
export function assertNodeWsModuleContext(context: NodeWsModuleContext, receiver: unknown): void {
  const state = getContext(context) ?? fail('copied or missing private context');
  checkPrototypes(state);
  let cursor: unknown = plainObject(receiver, state.isProxy);
  const target = cursor;
  const seen = new NativeSet<ObjectValue>();
  if (!callable(setHas) || !callable(setAdd)) fail('missing captured Set methods');
  while (cursor !== null && cursor !== undefined) {
    const owner = plainObject(cursor, state.isProxy);
    if (prototypeOf(owner) !== state.prototype) fail('non-default Module receiver prototype');
    if (apply(setHas, seen, [owner]) === true) fail('cyclic Module parent chain');
    apply(setAdd, seen, [owner]);
    // Node24's captured parent getter reads its private Symbol property. Validate all possible
    // own Symbol slots first, so the trusted getter cannot dispatch an application accessor.
    symbols(owner);
    const filename = data(owner, 'filename');
    const id = data(owner, 'id');
    if (typeof filename !== 'string' || typeof id !== 'string')
      fail('non-string Module parent identity');
    if (owner === target) assertTarget(state, owner);
    cursor = apply(state.parentGetter, owner, []);
  }
  checkPrototypes(state);
}
