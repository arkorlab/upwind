import { types } from 'node:util';

import { AuditError } from './dependencies.ts';

const MAX_ROOTS = 32;
const MAX_ENTRIES = 1_000_000;
/** Capture standard intrinsics without binding them to a particular collection. */
function intrinsic(object: unknown, key: string, field: 'value' | 'get' = 'value'): unknown {
  const ownDescriptor = Object.getOwnPropertyDescriptor(object, key);
  const value: unknown =
    ownDescriptor === undefined ? undefined : Reflect.get(ownDescriptor, field);
  if (typeof value !== 'function') throw new TypeError('Missing collection intrinsic');
  return value;
}
const MAP_ENTRIES = intrinsic(Map.prototype, 'entries') as Map<unknown, unknown>['entries'];
const MAP_NEXT = intrinsic(
  Object.getPrototypeOf(new Map<unknown, unknown>().entries()),
  'next',
) as ReturnType<typeof MAP_ENTRIES>['next'];
const SET_VALUES = intrinsic(Set.prototype, 'values') as Set<unknown>['values'];
const SET_NEXT = intrinsic(
  Object.getPrototypeOf(new Set<unknown>().values()),
  'next',
) as ReturnType<typeof SET_VALUES>['next'];
const MAP_SIZE = intrinsic(Map.prototype, 'size', 'get') as (this: unknown) => unknown;
const SET_SIZE = intrinsic(Set.prototype, 'size', 'get') as (this: unknown) => unknown;

/** A finite data-freshness failure; it never certifies a role, runtime or source origin. */
export class NodeManifestIdentityError extends AuditError {
  constructor(reason: string) {
    super(`Unproved original source identity ${reason}; refusing native publication`);
    this.name = 'NodeManifestIdentityError';
  }
}
export type IdentityObject = Record<PropertyKey, unknown>;
export function identityObject(value: unknown): value is IdentityObject {
  return typeof value === 'object' && value !== null;
}
export interface Property {
  readonly key: PropertyKey;
  readonly enumerable: boolean;
  readonly configurable: boolean;
  readonly writable: boolean;
  readonly value: unknown;
}
export type Collection =
  | { readonly kind: 'record' | 'array' }
  | { readonly kind: 'map'; readonly entries: readonly (readonly [unknown, unknown])[] }
  | { readonly kind: 'set'; readonly entries: readonly unknown[] };
export interface RecordSnapshot {
  readonly object: IdentityObject;
  readonly prototype: IdentityObject | null;
  readonly properties: readonly Property[];
  readonly collection: Collection;
}
export interface Budget {
  objects: number;
  entries: number;
}
export function refuse(reason: string): never {
  throw new NodeManifestIdentityError(reason);
}
function descriptor(object: unknown, key: PropertyKey): PropertyDescriptor {
  const actual = Object.getOwnPropertyDescriptor(object, key);
  if (
    actual === undefined ||
    !Object.hasOwn(actual, 'value') ||
    typeof actual.writable !== 'boolean' ||
    typeof actual.enumerable !== 'boolean' ||
    typeof actual.configurable !== 'boolean'
  )
    return refuse('accessor or missing own data property');
  const value: unknown = actual.value;
  if (typeof value === 'function') return refuse('function-valued property');
  return actual;
}
function dataProperty(object: unknown, key: PropertyKey): Property {
  const actual = descriptor(object, key);
  const value: unknown = actual.value;
  return Object.freeze({
    key,
    enumerable: actual.enumerable === true,
    configurable: actual.configurable === true,
    writable: actual.writable === true,
    value,
  });
}
/** The synthetic roots array is inspected without its iterator, getters or index reads. */
export function roots(values: readonly unknown[]): readonly unknown[] {
  if (
    types.isProxy(values) ||
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype
  )
    return refuse('roots array shape');
  const size = dataProperty(values, 'length').value;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_ROOTS)
    return refuse('roots bound');
  const keys = Reflect.ownKeys(values);
  if (keys.length !== size + 1 || keys[size] !== 'length') return refuse('roots keys or hook');
  const result: unknown[] = [];
  for (let index = 0; index < size; index += 1) {
    const key = String(index);
    if (keys[index] !== key) return refuse('roots order or holes');
    result.push(dataProperty(values, key).value);
  }
  return Object.freeze(result);
}
function collectionSize(value: unknown, getter: typeof MAP_SIZE): number {
  let size: unknown;
  try {
    size = getter.call(value);
  } catch (error) {
    if (error instanceof TypeError) return refuse('collection brand');
    throw error;
  }
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
    ? size
    : refuse('collection size');
}
function spend(budget: Budget, entries: number): void {
  budget.entries += entries;
  if (budget.entries > MAX_ENTRIES) refuse('entry bound');
}
function mapSnapshot(value: IdentityObject, budget: Budget): Collection {
  const size = collectionSize(value, MAP_SIZE);
  spend(budget, size * 2);
  const entries: (readonly [unknown, unknown])[] = [];
  const iterator = MAP_ENTRIES.call(value);
  for (let item = MAP_NEXT.call(iterator); item.done !== true; item = MAP_NEXT.call(iterator))
    entries.push(Object.freeze([item.value[0], item.value[1]]));
  if (entries.length !== size) return refuse('changed collection size');
  return Object.freeze({ kind: 'map', entries: Object.freeze(entries) });
}
function setSnapshot(value: IdentityObject, budget: Budget): Collection {
  const size = collectionSize(value, SET_SIZE);
  spend(budget, size);
  const entries: unknown[] = [];
  const iterator = SET_VALUES.call(value);
  for (let item = SET_NEXT.call(iterator); item.done !== true; item = SET_NEXT.call(iterator))
    entries.push(item.value);
  if (entries.length !== size) return refuse('changed collection size');
  return Object.freeze({ kind: 'set', entries: Object.freeze(entries) });
}
function prototypeOf(value: IdentityObject): IdentityObject | null {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && !identityObject(prototype)) return refuse('unsupported prototype');
  return prototype;
}
function properties(value: IdentityObject, budget: Budget): readonly Property[] {
  const keys = Reflect.ownKeys(value);
  spend(budget, keys.length);
  return Object.freeze(keys.map((key) => dataProperty(value, key)));
}
/** Only private control records may use own-only coverage, conjoined with deep source coverage. */
export function ownRecord(value: unknown, budget: Budget): RecordSnapshot {
  if (!identityObject(value) || types.isProxy(value)) return refuse('control wrapper shape');
  const prototype = prototypeOf(value);
  if (prototype !== null && !Object.is(prototype, Object.prototype))
    return refuse('control wrapper prototype');
  return Object.freeze({
    object: value,
    prototype,
    properties: properties(value, budget),
    collection: Object.freeze({ kind: 'record' }),
  });
}
export function record(value: IdentityObject, budget: Budget): RecordSnapshot {
  if (types.isProxy(value)) return refuse('proxy');
  const prototype = prototypeOf(value);
  let collection: Collection;
  if (Object.is(prototype, Map.prototype)) collection = mapSnapshot(value, budget);
  else if (Object.is(prototype, Set.prototype)) collection = setSnapshot(value, budget);
  else if (Array.isArray(value) && Object.is(prototype, Array.prototype)) {
    const length = dataProperty(value, 'length').value;
    if (typeof length !== 'number' || length > MAX_ENTRIES) return refuse('array bound');
    collection = Object.freeze({ kind: 'array' });
  } else if (prototype === null || Object.is(prototype, Object.prototype))
    collection = Object.freeze({ kind: 'record' });
  else return refuse('unsupported prototype');
  return Object.freeze({
    object: value,
    prototype,
    properties: properties(value, budget),
    collection,
  });
}
export function assertProperties(recorded: RecordSnapshot): void {
  const object = recorded.object;
  if (types.isProxy(object) || !Object.is(Object.getPrototypeOf(object), recorded.prototype))
    return refuse('changed object prototype');
  const keys = Reflect.ownKeys(object);
  if (keys.length !== recorded.properties.length) return refuse('changed object keys');
  for (const [index, property] of recorded.properties.entries()) {
    if (!Object.is(keys[index], property.key)) return refuse('changed own key order');
    const actual = descriptor(object, property.key);
    const value: unknown = actual.value;
    if (
      actual.enumerable !== property.enumerable ||
      actual.configurable !== property.configurable ||
      actual.writable !== property.writable ||
      !Object.is(value, property.value)
    )
      return refuse('changed property or identity');
  }
}
function assertMap(
  object: IdentityObject,
  collection: Extract<Collection, { readonly kind: 'map' }>,
): void {
  if (collectionSize(object, MAP_SIZE) !== collection.entries.length)
    return refuse('changed map size');
  const iterator = MAP_ENTRIES.call(object);
  for (const entry of collection.entries) {
    const item = MAP_NEXT.call(iterator);
    if (
      item.done === true ||
      !Object.is(item.value[0], entry[0]) ||
      !Object.is(item.value[1], entry[1])
    )
      return refuse('changed map entries or order');
  }
  if (MAP_NEXT.call(iterator).done !== true) return refuse('changed map entries');
}
function assertSet(
  object: IdentityObject,
  collection: Extract<Collection, { readonly kind: 'set' }>,
): void {
  if (collectionSize(object, SET_SIZE) !== collection.entries.length)
    return refuse('changed set size');
  const iterator = SET_VALUES.call(object);
  for (const entry of collection.entries) {
    const item = SET_NEXT.call(iterator);
    if (item.done === true || !Object.is(item.value, entry))
      return refuse('changed set entries or order');
  }
  if (SET_NEXT.call(iterator).done !== true) return refuse('changed set entries');
}
export function assertCollection(recorded: RecordSnapshot): void {
  const collection = recorded.collection;
  if (collection.kind === 'map') assertMap(recorded.object, collection);
  else if (collection.kind === 'set') assertSet(recorded.object, collection);
}
