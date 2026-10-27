type ObjectValue = Record<PropertyKey, unknown>;
const SOURCE_BYTES = 3066;
export interface NodeNextHookRecord {
  readonly schema: 1;
  readonly profile: 'next-16.4.3-require-hook-v1';
  readonly nodeVersion: '24.22.1';
  readonly archivePath: string;
  readonly sha256: 'e82f0ceba88d025c725ea3062974ad9d7a54a892df8c34a525cb129202387db8';
  readonly bytes: typeof SOURCE_BYTES;
}
export interface NodeNextHookAlias {
  readonly request: string;
  readonly target: string;
}
export interface NodeNextHookEdge {
  readonly caller: string;
  readonly specifier: string;
  readonly target: string;
}
export interface NodeNextHookConfig {
  readonly record: NodeNextHookRecord;
  readonly aliases: readonly NodeNextHookAlias[];
  readonly sharedRuntimeEdges: readonly NodeNextHookEdge[];
}
const descriptorOf = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const objectPrototype = Object.prototype;
const NativeError = Error;
const MAX_EDGES = 10_000;
const MAX_PATH_BYTES = 4096;
const REQUESTS = ['styled-jsx', 'styled-jsx/style', 'styled-jsx/style.js'] as const;
const SUFFIX = '/dist/server/require-hook.js';
const SHARED_SUFFIX = '.shared-runtime';
const CONTEXTS = '/dist/server/route-modules/pages/vendored/contexts/';
type ProxyCheck = (value: unknown) => boolean;
function fail(reason: string): never {
  throw new NativeError(`Unsupported Next hook record: ${reason}`);
}
function object(value: unknown, isProxy: ProxyCheck): ObjectValue {
  if (typeof value !== 'object' || value === null || isProxy(value))
    fail('proxy or non-object DATA');
  return value;
}
function keys(value: unknown, names: readonly string[], isProxy: ProxyCheck): ObjectValue {
  const owner = object(value, isProxy);
  const prototype: unknown = prototypeOf(owner);
  if (prototype !== objectPrototype && prototype !== null) fail('non-plain DATA object');
  const actual = ownKeys(owner);
  if (
    actual.length !== names.length ||
    actual.some((name) => typeof name !== 'string' || !names.includes(name))
  )
    fail('unexpected DATA keys');
  return owner;
}
function data(owner: ObjectValue, key: PropertyKey): unknown {
  const descriptor = descriptorOf(owner, key);
  if (descriptor === undefined || !hasOwn(descriptor, 'value')) fail('required own DATA');
  const value: unknown = descriptor.value;
  return value;
}
function path(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length > MAX_PATH_BYTES ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes(':') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail('archive path boundary');
  return value;
}
function list(value: unknown, maximum: number, isProxy: ProxyCheck): readonly unknown[] {
  const owner = object(value, isProxy);
  if (!arrayIsArray(owner) || prototypeOf(owner) !== arrayPrototype) fail('non-default array');
  const length = data(owner, 'length');
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum ||
    ownKeys(owner).length !== length + 1
  )
    fail('non-dense or oversized DATA array');
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) values[index] = data(owner, String(index));
  return values;
}
function record(value: unknown, isProxy: ProxyCheck): NodeNextHookRecord {
  const owner = keys(
    value,
    ['schema', 'profile', 'nodeVersion', 'archivePath', 'sha256', 'bytes'],
    isProxy,
  );
  if (
    data(owner, 'schema') !== 1 ||
    data(owner, 'profile') !== 'next-16.4.3-require-hook-v1' ||
    data(owner, 'nodeVersion') !== '24.22.1' ||
    data(owner, 'sha256') !== 'e82f0ceba88d025c725ea3062974ad9d7a54a892df8c34a525cb129202387db8' ||
    data(owner, 'bytes') !== SOURCE_BYTES
  )
    fail('fixed source identity');
  const archivePath = path(data(owner, 'archivePath'));
  if (!archivePath.endsWith(SUFFIX)) fail('fixed source coordinate');
  const root = archivePath.slice(0, -SUFFIX.length);
  if (root !== 'node_modules/next' && !root.endsWith('/node_modules/next')) fail('fixed Next root');
  return freeze({
    schema: 1,
    profile: 'next-16.4.3-require-hook-v1',
    nodeVersion: '24.22.1',
    archivePath,
    sha256: 'e82f0ceba88d025c725ea3062974ad9d7a54a892df8c34a525cb129202387db8',
    bytes: SOURCE_BYTES,
  });
}
function aliases(value: unknown, isProxy: ProxyCheck): readonly NodeNextHookAlias[] {
  const values = list(value, REQUESTS.length, isProxy);
  const result: NodeNextHookAlias[] = [];
  let previous = -1;
  let index = 0;
  while (index < values.length) {
    const owner = keys(values[index], ['request', 'target'], isProxy);
    const request = data(owner, 'request');
    const position = REQUESTS.findIndex((name) => name === request);
    if (typeof request !== 'string' || position <= previous)
      fail('unknown, duplicate or reordered default alias');
    previous = position;
    result[index] = freeze({ request, target: path(data(owner, 'target')) });
    index += 1;
  }
  return freeze(result);
}
function edges(
  value: unknown,
  own: NodeNextHookRecord,
  isProxy: ProxyCheck,
): readonly NodeNextHookEdge[] {
  const values = list(value, MAX_EDGES, isProxy);
  const prefix = `${own.archivePath.slice(0, -SUFFIX.length)}${CONTEXTS}`;
  const seen = new Map<string, string>();
  const result: NodeNextHookEdge[] = [];
  let index = 0;
  while (index < values.length) {
    const owner = keys(values[index], ['caller', 'specifier', 'target'], isProxy);
    index += 1;
    const caller = path(data(owner, 'caller'));
    const specifier = data(owner, 'specifier');
    const target = path(data(owner, 'target'));
    if (
      typeof specifier !== 'string' ||
      specifier.length > MAX_PATH_BYTES ||
      specifier.includes('\0') ||
      !specifier.endsWith(SHARED_SUFFIX) ||
      !target.startsWith(prefix)
    )
      fail('shared-runtime edge boundary');
    const key = `${caller}\0${specifier}`;
    const previous = seen.get(key);
    if (previous !== undefined && previous !== target) fail('conflicting shared-runtime edge');
    if (previous === undefined) result.push(freeze({ caller, specifier, target }));
    seen.set(key, target);
  }
  return freeze(result);
}

/** Copies only finite DATA. This parser never loads a module or qualifies a source on its own. */
export function nodeNextHookRecord(value: unknown, isProxy: ProxyCheck): NodeNextHookConfig {
  const owner = keys(value, ['record', 'aliases', 'sharedRuntimeEdges'], isProxy);
  const own = record(data(owner, 'record'), isProxy);
  return freeze({
    record: own,
    aliases: aliases(data(owner, 'aliases'), isProxy),
    sharedRuntimeEdges: edges(data(owner, 'sharedRuntimeEdges'), own, isProxy),
  });
}
