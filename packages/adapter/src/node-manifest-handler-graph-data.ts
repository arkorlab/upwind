import { createHash } from 'node:crypto';

import type {
  NodeManifestTurbopackModuleId,
  NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';
import type { NodeManifestWholeFactoryData } from './node-manifest-whole-factory-data.ts';

export interface ModuleData {
  readonly runtime: string;
  readonly moduleId: NodeManifestTurbopackModuleId;
}
export type TargetData =
  | (ModuleData & { readonly kind: 'module' })
  | {
      readonly kind: 'builtin';
      readonly id: string;
      readonly aliases?: readonly string[] | undefined;
    }
  | {
      readonly kind: 'next-source';
      readonly root: string;
      readonly relative: string;
      readonly file: string;
      readonly sha256: string;
    };
export interface NodeManifestHandlerImportData {
  readonly kind: 'import' | 'require' | 'external';
  readonly specifier: string;
  readonly targetId?: NodeManifestTurbopackModuleId | undefined;
  readonly target: TargetData;
}
interface RowData extends ModuleData {
  readonly physicalId: string;
  readonly imports: readonly NodeManifestHandlerImportData[];
  readonly operations: Pick<
    NodeManifestTurbopackProjection,
    'cacheInitializers' | 'asyncLoads' | 'asyncLoader' | 'boundRuntimeInputs'
  >;
}
export interface NodeManifestHandlerRowData extends RowData {
  readonly mode?: 'full' | undefined;
  readonly whole: NodeManifestWholeFactoryData;
}
export interface NodeManifestHandlerFingerprintRowData extends RowData {
  readonly mode: 'fingerprint';
  readonly whole: Omit<NodeManifestWholeFactoryData, 'canonical'>;
  readonly canonicalSha256: string;
}
export type ReferenceRowData = NodeManifestHandlerRowData | NodeManifestHandlerFingerprintRowData;
export interface NodeManifestHandlerGraphData<
  T extends ReferenceRowData = NodeManifestHandlerRowData,
> {
  readonly root: ModuleData;
  readonly nextRoot: string;
  readonly rows: readonly T[];
}
export type NodeManifestHandlerReferenceGraphData = NodeManifestHandlerGraphData<ReferenceRowData>;
export interface NodeManifestHandlerLiteralSlot {
  readonly key: string;
  readonly row: ModuleData;
  readonly path: readonly (string | number)[];
  readonly referenceValue: string;
}
export interface NodeManifestHandlerGraphInput {
  readonly reference: NodeManifestHandlerReferenceGraphData;
  readonly actual: NodeManifestHandlerGraphData;
  readonly literalSlots?:
    | {
        readonly expected: readonly NodeManifestHandlerLiteralSlot[];
        readonly actual: readonly { readonly key: string; readonly value: string }[];
      }
    | undefined;
}
export type Reason =
  | 'bounds'
  | 'data'
  | 'duplicate-registration'
  | 'alias-group'
  | 'unresolved-target'
  | 'bijection'
  | 'canonical'
  | 'ports'
  | 'resolution'
  | 'leaf'
  | 'slots'
  | 'unsupported-operation'
  | 'closure';
export interface NodeManifestHandlerGraphComparison {
  readonly version: 1;
  readonly status: 'UNQUALIFIED';
  readonly comparison: 'equal' | 'different' | 'unsupported';
  readonly reason: Reason | undefined;
  readonly bindings: readonly { readonly reference: ModuleData; readonly actual: ModuleData }[];
  readonly counts: Readonly<{
    rows: number;
    ports: number;
    occurrences: number;
    leaves: number;
    slots: number;
  }>;
}
const MAX_ROWS = 256;
const MAX_IDS = 4096;
const MAX_OCCURRENCES = 8192;
const MAX_CANONICAL = 4_194_304;
const MAX_TOTAL = 16_777_216;
const MAX_TEXT = 4096;
const MAX_AST_NODES = 100_000;
const MAX_AST_DEPTH = 256;
const MAX_SLOT_DEPTH = 128;
const MIN_SLOT_PATH = 3;
const MAX_SLOTS = 128;
const MAX_ALIASES = 8;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export class MismatchError extends Error {
  readonly reason: Reason;
  readonly comparison: 'different' | 'unsupported';
  constructor(
    reason: Reason,
    options?: ErrorOptions & { readonly comparison: 'different' | 'unsupported' },
  ) {
    super(reason, options);
    this.name = 'MismatchError';
    this.reason = reason;
    this.comparison = options?.comparison ?? 'unsupported';
  }
}
export function refuse(reason: Reason): never {
  throw new MismatchError(reason);
}
export function different(reason: Reason): never {
  throw new MismatchError(reason, { comparison: 'different' });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function text(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TEXT &&
    !value.includes('\0')
  );
}
function id(value: NodeManifestTurbopackModuleId): boolean {
  return typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0 : text(value);
}
export function key(value: ModuleData): string {
  if (!text(value.runtime) || !id(value.moduleId)) refuse('data');
  return JSON.stringify([value.runtime, typeof value.moduleId, value.moduleId]);
}
export function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function stringBytes(value: unknown): number {
  if (typeof value !== 'string') return 0;
  if (value.length > MAX_CANONICAL) refuse('bounds');
  return Buffer.byteLength(value);
}

function canonicalBounds(parsed: unknown): void {
  const pending = [{ value: parsed, depth: 0 }];
  let count = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    count += 1;
    if (count > MAX_AST_NODES || current.depth > MAX_AST_DEPTH) refuse('bounds');
    bytes += stringBytes(current.value);
    if (bytes > MAX_TOTAL) refuse('bounds');
    if (Array.isArray(current.value) || record(current.value)) {
      const values = Object.values(current.value);
      if (values.length + pending.length + count > MAX_AST_NODES) refuse('bounds');
      for (const nested of values) pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
}

export function canonical(value: string): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_CANONICAL) refuse('bounds');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return refuse('data');
    throw error;
  }
  canonicalBounds(parsed);
  if (JSON.stringify(parsed) !== value) refuse('data');
  return parsed;
}
function vector(row: ReferenceRowData): string {
  return createHash('sha256')
    .update(JSON.stringify([row.physicalId, row.whole.originalSha256, row.whole.factory]))
    .digest('hex');
}
function identity(row: ReferenceRowData): void {
  const whole = row.whole;
  const factory = whole.factory;
  if (
    !text(row.physicalId) ||
    !/^[a-f\d]{64}$/u.test(whole.originalSha256) ||
    whole.version !== 1 ||
    !Number.isSafeInteger(factory.start) ||
    !Number.isSafeInteger(factory.end) ||
    factory.start < 0 ||
    factory.end <= factory.start ||
    factory.ids.length === 0 ||
    factory.ids.some((value) => !id(value)) ||
    new Set(factory.ids).size !== factory.ids.length ||
    !Number.isSafeInteger(whole.selectedOrdinal) ||
    factory.ids[whole.selectedOrdinal] !== row.moduleId
  )
    refuse('data');
}
function shape(row: ReferenceRowData, reference: boolean): void {
  const whole = row.whole;
  if (row.mode === 'fingerprint') {
    if (
      !reference ||
      !/^[a-f\d]{64}$/u.test(row.canonicalSha256) ||
      Object.hasOwn(whole, 'canonical')
    )
      refuse('data');
  } else {
    if (Object.hasOwn(row, 'canonicalSha256')) refuse('data');
    const parsed = canonical(row.whole.canonical);
    if (
      !record(parsed) ||
      parsed['version'] !== 1 ||
      !same(
        parsed['registeredTypes'],
        whole.factory.ids.map((value) => typeof value),
      ) ||
      parsed['selectedOrdinal'] !== whole.selectedOrdinal ||
      !same(parsed['strictContext'], whole.strictContext) ||
      !record(parsed['callback'])
    )
      refuse('data');
  }
  const operations = row.operations;
  if (
    operations.cacheInitializers.length > 0 ||
    operations.asyncLoads.length > 0 ||
    operations.asyncLoader !== undefined ||
    operations.boundRuntimeInputs.length > 0
  )
    refuse('unsupported-operation');
}
function occurrence(
  item: NodeManifestWholeFactoryData['ports'][number]['occurrences'][number],
  factory: NodeManifestWholeFactoryData['factory'],
  last: number,
): void {
  if (
    !['import', 'require'].includes(item.kind) ||
    !Number.isSafeInteger(item.start) ||
    !Number.isSafeInteger(item.end) ||
    item.start < factory.start ||
    item.end > factory.end ||
    item.end <= item.start ||
    item.start <= last
  )
    refuse('ports');
}
function checkPort(
  port: NodeManifestWholeFactoryData['ports'][number],
  ordinal: number,
  seen: Set<NodeManifestTurbopackModuleId>,
): number {
  if (
    port.ordinal !== ordinal ||
    !id(port.id) ||
    port.idType !== typeof port.id ||
    seen.has(port.id) ||
    port.occurrences.length === 0
  )
    refuse('ports');
  seen.add(port.id);
  return port.occurrences[0]?.start ?? -1;
}

function checkPorts(row: ReferenceRowData): number {
  const seen = new Set<NodeManifestTurbopackModuleId>();
  let previous = -1;
  let count = 0;
  if (row.whole.ports.length > MAX_OCCURRENCES) refuse('bounds');
  for (const [ordinal, port] of row.whole.ports.entries()) {
    count += port.occurrences.length;
    if (count > MAX_OCCURRENCES) refuse('bounds');
    const start = checkPort(port, ordinal, seen);
    if (start <= previous) refuse('ports');
    previous = start;
    let last = -1;
    for (const item of port.occurrences) {
      occurrence(item, row.whole.factory, last);
      last = item.start;
    }
  }
  return count;
}
function siblings(rows: ReadonlyMap<string, ReferenceRowData>): void {
  const vectors = new Map([...rows.values()].map((row) => [row, vector(row)]));
  for (const row of rows.values())
    for (const moduleId of row.whole.factory.ids) {
      const sibling = rows.get(key({ runtime: row.runtime, moduleId }));
      if (sibling === undefined || vectors.get(row) !== vectors.get(sibling)) refuse('alias-group');
    }
}

export function index<T extends ReferenceRowData>(
  graph: NodeManifestHandlerGraphData<T>,
  reference = false,
): Map<string, T> {
  if (graph.rows.length === 0 || graph.rows.length > MAX_ROWS) refuse('bounds');
  const result = new Map<string, T>();
  const totals = { bytes: 0, ids: 0, imports: 0, occurrences: 0 };
  for (const row of graph.rows) {
    const rowKey = key(row);
    if (result.has(rowKey)) refuse('duplicate-registration');
    result.set(rowKey, row);
    totals.ids += row.whole.factory.ids.length;
    totals.bytes += row.mode === 'fingerprint' ? 0 : Buffer.byteLength(row.whole.canonical);
    totals.imports += row.imports.length;
    if (totals.ids > MAX_IDS || totals.bytes > MAX_TOTAL || totals.imports > MAX_OCCURRENCES)
      refuse('bounds');
    identity(row);
    canonicalBounds(row.whole.strictContext);
    totals.bytes += Buffer.byteLength(JSON.stringify(row.whole.strictContext));
    if (totals.bytes > MAX_TOTAL) refuse('bounds');
    shape(row, reference);
    totals.occurrences += checkPorts(row);
    if (totals.occurrences > MAX_OCCURRENCES) refuse('bounds');
  }
  siblings(result);
  return result;
}
function child(value: unknown, step: string | number): unknown {
  if (typeof step === 'number') {
    if (
      !Array.isArray(value) ||
      !Number.isSafeInteger(step) ||
      step < 0 ||
      step >= value.length ||
      !Object.hasOwn(value, step)
    )
      refuse('slots');
    return value.at(step);
  }
  if (
    typeof step !== 'string' ||
    step.length > MAX_SLOT_DEPTH ||
    !record(value) ||
    FORBIDDEN_KEYS.has(step) ||
    !Object.hasOwn(value, step)
  )
    refuse('slots');
  return value[step];
}
export function literal(
  root: unknown,
  path: readonly (string | number)[],
): Record<string, unknown> {
  if (
    path.length < MIN_SLOT_PATH ||
    path.length > MAX_SLOT_DEPTH ||
    path[0] !== 'callback' ||
    path.at(-1) !== 'value'
  )
    refuse('slots');
  let current = root;
  let previous: unknown;
  const ancestors = path.slice(0, -1);
  for (const step of ancestors) {
    previous = current;
    current = child(current, step);
  }
  if (
    !record(current) ||
    (record(previous) && previous['type'] === 'ExpressionStatement') ||
    current['type'] !== 'Literal' ||
    !Object.hasOwn(current, 'value') ||
    typeof current['value'] !== 'string'
  )
    refuse('slots');
  return current;
}
export interface MaterializedSlot {
  readonly expected: NodeManifestHandlerLiteralSlot;
  readonly actual: string;
}
function slotValues(
  values: readonly { readonly key: string; readonly value: string }[],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    if (
      !text(value.key) ||
      result.has(value.key) ||
      typeof value.value !== 'string' ||
      value.value.length > MAX_CANONICAL
    )
      refuse('slots');
    result.set(value.key, value.value);
  }
  return result;
}
export function materializedSlots(
  input: NodeManifestHandlerGraphInput,
  rows: ReadonlyMap<string, ReferenceRowData>,
): ReadonlyMap<string, readonly MaterializedSlot[]> {
  const actual = input.literalSlots?.actual ?? [];
  const expected = input.literalSlots?.expected ?? [];
  if (expected.length > MAX_SLOTS || actual.length > MAX_SLOTS) refuse('bounds');
  const keys = new Set<string>(),
    paths = new Set<string>(),
    values = slotValues(actual);
  const result = new Map<string, readonly MaterializedSlot[]>();
  for (const slot of expected) {
    const row = key(slot.row);
    if (slot.path.length > MAX_SLOT_DEPTH) refuse('slots');
    const path = JSON.stringify([row, slot.path]);
    if (
      !rows.has(row) ||
      !text(slot.key) ||
      keys.has(slot.key) ||
      !values.has(slot.key) ||
      paths.has(path) ||
      typeof slot.referenceValue !== 'string' ||
      slot.referenceValue.length > MAX_CANONICAL
    )
      refuse('slots');
    paths.add(path);
    keys.add(slot.key);
    const value = values.get(slot.key);
    if (value === undefined) refuse('slots');
    result.set(row, [...(result.get(row) ?? []), { expected: slot, actual: value }]);
  }
  if (keys.size !== values.size) refuse('slots');
  return result;
}
export function sourceFile(
  target: Extract<TargetData, { kind: 'next-source' }>,
  graph: NodeManifestHandlerReferenceGraphData,
): void {
  if (!text(target.relative) || !text(target.root)) refuse('leaf');
  const parts = target.relative.split('/');
  if (
    target.root !== graph.nextRoot ||
    !text(target.root) ||
    !target.root.startsWith('/') ||
    target.root.includes('\\') ||
    (target.root.length > 1 && target.root.endsWith('/')) ||
    !text(target.relative) ||
    target.relative.includes('\\') ||
    parts.some((part) => part === '' || part === '.' || part === '..') ||
    !/^[a-f\d]{64}$/u.test(target.sha256) ||
    target.file !== `${target.root === '/' ? '' : target.root}/${target.relative}`
  )
    refuse('leaf');
}
export function builtin(
  reference: Extract<TargetData, { kind: 'builtin' }>,
  actual: Extract<TargetData, { kind: 'builtin' }>,
): void {
  const aliases = reference.aliases ?? [reference.id];
  if (
    aliases.length === 0 ||
    aliases.length > MAX_ALIASES ||
    aliases.some((value) => !text(value)) ||
    new Set(aliases).size !== aliases.length ||
    !aliases.includes(reference.id) ||
    actual.aliases !== undefined
  )
    refuse('leaf');
  if (!aliases.includes(actual.id)) different('leaf');
}
export function occurrences(row: ReferenceRowData): unknown {
  return row.whole.ports
    .flatMap((port) => {
      return port.occurrences.map((item) => {
        return {
          ordinal: port.ordinal,
          kind: item.kind,
          start: item.start,
        };
      });
    })
    .toSorted((a, b) => a.start - b.start)
    .map(({ ordinal, kind }) => [ordinal, kind]);
}
