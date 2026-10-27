const descriptorOf = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const deleteProperty = Reflect.deleteProperty;
const isExtensible = Object.isExtensible;
const hasOwn = Object.hasOwn;
const sameValue = Object.is;
const freeze = Object.freeze;
const NativeError = Error;
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

type ObjectValue = Record<PropertyKey, unknown>;
interface Slot {
  readonly owner: ObjectValue;
  readonly key: PropertyKey;
  readonly baseline: PropertyDescriptor | undefined;
}
interface State {
  readonly slots: readonly Slot[];
  depth: number;
  poisoned: boolean;
}
const BRAND = Symbol('Node error hooks');
export interface NodeErrorHooks {
  readonly [BRAND]: true;
}
const STATES = new WeakMap<NodeErrorHooks, State>();
const getState = STATES.get.bind(STATES);
const setState = STATES.set.bind(STATES);

function fail(): never {
  throw new NativeError('Unsupported Node error hooks: non-restorable initialization scope');
}
function object(value: unknown): value is ObjectValue {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
function stored(token: NodeErrorHooks): State {
  return getState(token) ?? fail();
}
export function sameNodeBuiltinDescriptor(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (
    left.configurable !== right.configurable ||
    left.enumerable !== right.enumerable ||
    hasOwn(left, 'value') !== hasOwn(right, 'value')
  )
    return false;
  return hasOwn(left, 'value')
    ? left.writable === right.writable && sameValue(left.value, right.value)
    : left.get === right.get && left.set === right.set;
}
/** ToPropertyDescriptor must never consult application-mutated Object.prototype fields. */
function capturedDescriptor(owner: ObjectValue, key: PropertyKey): PropertyDescriptor | undefined {
  const current = descriptorOf(owner, key);
  // Native descriptors contain only own DATA fields of their specific descriptor kind.
  if (current === undefined) return undefined;
  const descriptor = { __proto__: null, ...current };
  return descriptor;
}
function slot(owner: ObjectValue, key: PropertyKey): Slot {
  const descriptor = capturedDescriptor(owner, key);
  if (descriptor !== undefined && !hasOwn(descriptor, 'value')) fail();
  return freeze({
    owner,
    key,
    baseline: descriptor === undefined ? undefined : freeze(descriptor),
  });
}
function poison(state: State): never {
  state.poisoned = true;
  return fail();
}
function reversible(state: State, own: Slot, current: PropertyDescriptor | undefined): void {
  if (sameNodeBuiltinDescriptor(current, own.baseline)) return;
  if (
    state.depth !== 0 ||
    (current !== undefined && current.configurable !== true) ||
    (own.baseline !== undefined && own.baseline.configurable !== true) ||
    ((current === undefined || own.baseline === undefined) && !isExtensible(own.owner))
  )
    poison(state);
}
function preflight(state: State): readonly (PropertyDescriptor | undefined)[] {
  if (state.poisoned) fail();
  const first = state.slots[0] ?? fail();
  const second = state.slots[1] ?? fail();
  const descriptors = [
    capturedDescriptor(first.owner, first.key),
    capturedDescriptor(second.owner, second.key),
  ];
  reversible(state, first, descriptors[0]);
  reversible(state, second, descriptors[1]);
  return descriptors;
}
function put(own: Slot, descriptor: PropertyDescriptor | undefined): void {
  if (sameNodeBuiltinDescriptor(descriptorOf(own.owner, own.key), descriptor)) return;
  if (descriptor === undefined) {
    if (!deleteProperty(own.owner, own.key)) fail();
  } else defineProperty(own.owner, own.key, descriptor);
  if (!sameNodeBuiltinDescriptor(descriptorOf(own.owner, own.key), descriptor)) fail();
}
function restore(state: State, saved: readonly (PropertyDescriptor | undefined)[]): void {
  let index = 0;
  while (index < state.slots.length) {
    const own = state.slots[index];
    const descriptor = saved[index];
    index += 1;
    try {
      if (own === undefined) fail();
      put(own, descriptor);
    } catch {
      state.poisoned = true;
    }
  }
}

/** Trusted pre-app Error owners only; capture DATA/absence without invoking either hook. */
export function captureNodeErrorHooks(errorCtor: unknown, prototype: unknown): NodeErrorHooks {
  if (typeof errorCtor !== 'function' || !object(errorCtor) || !object(prototype)) fail();
  const descriptor = descriptorOf(errorCtor, 'prototype');
  if (descriptor === undefined || !hasOwn(descriptor, 'value') || descriptor.value !== prototype)
    fail();
  const token = freeze({ [BRAND]: true as const });
  setState(token, {
    slots: freeze([slot(errorCtor, 'prepareStackTrace'), slot(prototype, INSPECT)]),
    depth: 0,
    poisoned: false,
  });
  return token;
}

/** Read-only health check; customizable descriptors must remain synchronously reversible. */
export function assertNodeErrorHooks(token: NodeErrorHooks): void {
  preflight(stored(token));
}

/** Exact captured-owner/key predicate for realm snapshot filtering; no caller-supplied exemptions. */
export function nodeErrorHookKey(
  hooks: NodeErrorHooks | undefined,
  owner: unknown,
  key: PropertyKey,
): boolean {
  if (hooks === undefined) return false;
  const state = stored(hooks);
  const first = state.slots[0];
  const second = state.slots[1];
  return (
    (first !== undefined && first.owner === owner && first.key === key) ||
    (second !== undefined && second.owner === owner && second.key === key)
  );
}

/** Synchronous protected initialization only; ordinary application formatting stays installed. */
export function withPristineNodeErrorHooks<T>(token: NodeErrorHooks, callback: () => T): T {
  const state = stored(token);
  // Check BOTH slots before installing either baseline, including restoration feasibility.
  const saved = preflight(state);
  state.depth += 1;
  let installed = false;
  try {
    let index = 0;
    while (index < state.slots.length) {
      const own = state.slots[index];
      index += 1;
      if (own === undefined) fail();
      put(own, own.baseline);
    }
    installed = true;
    return callback();
  } finally {
    if (!installed) state.poisoned = true;
    let index = 0;
    while (index < state.slots.length) {
      const own = state.slots[index];
      index += 1;
      if (
        own === undefined ||
        !sameNodeBuiltinDescriptor(descriptorOf(own.owner, own.key), own.baseline)
      )
        state.poisoned = true;
    }
    restore(state, saved);
    state.depth -= 1;
    if (state.poisoned) fail();
  }
}
