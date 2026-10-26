import { createHash } from 'node:crypto';

import {
  canonical,
  different,
  index,
  key,
  literal,
  builtin,
  materializedSlots,
  MismatchError,
  occurrences,
  refuse,
  same,
  sourceFile,
  text,
  type ModuleData,
  type MaterializedSlot,
  type NodeManifestHandlerImportData,
  type NodeManifestHandlerRowData,
  type NodeManifestHandlerGraphComparison,
  type NodeManifestHandlerGraphInput,
  type Reason,
  type ReferenceRowData,
} from './node-manifest-handler-graph-data.ts';

export type {
  ModuleData,
  TargetData,
  ReferenceRowData,
  NodeManifestHandlerGraphData,
  NodeManifestHandlerReferenceGraphData,
  NodeManifestHandlerFingerprintRowData,
  NodeManifestHandlerImportData,
  NodeManifestHandlerRowData,
  NodeManifestHandlerLiteralSlot,
  NodeManifestHandlerGraphComparison,
  NodeManifestHandlerGraphInput,
} from './node-manifest-handler-graph-data.ts';

/** Exact comparison-DATA encoding: {"type":"input-relative-literal-slot","key":<static key>}. */
export function nodeManifestHandlerLiteralToken(
  slotKey: string,
): Readonly<{ type: 'input-relative-literal-slot'; key: string }> {
  if (!text(slotKey)) refuse('slots');
  return Object.freeze({ type: 'input-relative-literal-slot', key: slotKey });
}

function portTarget(
  row: ReferenceRowData,
  port: ReferenceRowData['whole']['ports'][number],
  entries: readonly NodeManifestHandlerImportData[],
): NodeManifestHandlerImportData {
  for (const kind of ['import', 'require'])
    if (
      entries.filter((entry) => entry.kind === kind).length !==
      port.occurrences.filter((item) => item.kind === kind).length
    )
      refuse('resolution');
  const first = entries[0];
  if (
    first === undefined ||
    first.target.kind !== 'module' ||
    first.target.runtime !== row.runtime ||
    first.target.moduleId !== port.id
  )
    refuse('resolution');
  for (const entry of entries)
    if (
      entry.target.kind !== 'module' ||
      !same(entry.target, first.target) ||
      entry.specifier !== first.specifier
    )
      refuse('resolution');
  return first;
}

class Comparison {
  private readonly forward = new Map<string, string>();
  private readonly reverse = new Map<string, string>();
  private readonly runtimes = new Map<string, string>();
  private readonly reverseRuntimes = new Map<string, string>();
  private readonly referenceRows: Map<string, ReferenceRowData>;
  private readonly actualRows: Map<string, NodeManifestHandlerRowData>;
  private readonly pending: [ReferenceRowData, NodeManifestHandlerRowData][] = [];
  private readonly visited = new Set<string>();
  private readonly slots: ReadonlyMap<string, readonly MaterializedSlot[]>;

  private readonly input: NodeManifestHandlerGraphInput;
  readonly bindings: { readonly reference: ModuleData; readonly actual: ModuleData }[] = [];
  readonly counts = { rows: 0, ports: 0, occurrences: 0, leaves: 0, slots: 0 };
  constructor(input: NodeManifestHandlerGraphInput) {
    this.input = input;
    this.referenceRows = index(input.reference, true);
    this.actualRows = index(input.actual);
    this.slots = materializedSlots(input, this.referenceRows);
  }

  private bind(reference: ModuleData, actual: ModuleData): void {
    const act = key(actual),
      ref = key(reference);
    if (
      typeof reference.moduleId !== typeof actual.moduleId ||
      (this.forward.has(ref) && this.forward.get(ref) !== act) ||
      (this.reverse.has(act) && this.reverse.get(act) !== ref) ||
      (this.runtimes.has(reference.runtime) &&
        this.runtimes.get(reference.runtime) !== actual.runtime) ||
      (this.reverseRuntimes.has(actual.runtime) &&
        this.reverseRuntimes.get(actual.runtime) !== reference.runtime)
    )
      different('bijection');
    if (this.forward.has(ref)) return;
    const left = this.referenceRows.get(ref),
      right = this.actualRows.get(act);
    if (left === undefined || right === undefined) refuse('unresolved-target');
    this.forward.set(ref, act);
    this.reverse.set(act, ref);
    this.runtimes.set(reference.runtime, actual.runtime);
    this.reverseRuntimes.set(actual.runtime, reference.runtime);
    this.bindings.push({
      reference: Object.freeze({ runtime: reference.runtime, moduleId: reference.moduleId }),
      actual: Object.freeze({ runtime: actual.runtime, moduleId: actual.moduleId }),
    });
    this.pending.push([left, right]);
  }

  private compareCanonical(reference: ReferenceRowData, actual: NodeManifestHandlerRowData): void {
    const left =
        reference.mode === 'fingerprint' ? undefined : canonical(reference.whole.canonical),
      right = canonical(actual.whole.canonical);
    const slots = this.slots.get(key(reference)) ?? [];
    for (const slot of slots) {
      const act = literal(right, slot.expected.path);
      const ref = left === undefined ? undefined : literal(left, slot.expected.path);
      if (
        (ref !== undefined && ref['value'] !== slot.expected.referenceValue) ||
        act['value'] !== slot.actual
      )
        refuse('slots');
      const token = nodeManifestHandlerLiteralToken(slot.expected.key);
      if (ref !== undefined) ref['value'] = token;
      act['value'] = token;
      this.counts.slots += 1;
    }
    if (reference.mode === 'fingerprint') {
      const digest = createHash('sha256').update(JSON.stringify(right)).digest('hex');
      if (digest !== reference.canonicalSha256) different('canonical');
    } else if (!same(left, right)) different('canonical');
  }

  private ports(row: ReferenceRowData): readonly NodeManifestHandlerImportData[] {
    const internal = new Map<string, NodeManifestHandlerImportData[]>();
    let total = 0;
    for (const entry of row.imports) {
      if (!text(entry.specifier) || !['external', 'import', 'require'].includes(entry.kind))
        refuse('resolution');
      if (entry.kind === 'external') continue;
      if (entry.targetId === undefined) refuse('resolution');
      const identity = key({ runtime: row.runtime, moduleId: entry.targetId });
      internal.set(identity, [...(internal.get(identity) ?? []), entry]);
      total += 1;
    }
    const targets: NodeManifestHandlerImportData[] = [];
    let consumed = 0;
    for (const port of row.whole.ports) {
      const entries = internal.get(key({ runtime: row.runtime, moduleId: port.id })) ?? [];
      const target = portTarget(row, port, entries);
      consumed += entries.length;
      targets.push(target);
    }
    if (consumed !== total) refuse('resolution');
    return targets;
  }

  private leaves(reference: ReferenceRowData, actual: NodeManifestHandlerRowData): void {
    const left = reference.imports.filter((entry) => entry.kind === 'external'),
      right = actual.imports.filter((entry) => entry.kind === 'external');
    if (left.length !== right.length) different('resolution');
    for (const [ordinal, ref] of left.entries()) {
      const act = right[ordinal];
      if (
        act === undefined ||
        ref.specifier !== act.specifier ||
        ref.targetId !== undefined ||
        act.targetId !== undefined
      )
        different('resolution');
      if (ref.target.kind === 'builtin' && act.target.kind === 'builtin') {
        builtin(ref.target, act.target);
      } else if (ref.target.kind === 'next-source' && act.target.kind === 'next-source') {
        sourceFile(ref.target, this.input.reference);
        sourceFile(act.target, this.input.actual);
        if (ref.target.relative !== act.target.relative || ref.target.sha256 !== act.target.sha256)
          different('leaf');
      } else refuse('leaf');
      this.counts.leaves += 1;
    }
  }

  private pair(reference: ReferenceRowData, actual: NodeManifestHandlerRowData): void {
    const left = reference.whole,
      right = actual.whole;
    if (
      left.selectedOrdinal !== right.selectedOrdinal ||
      left.factory.ids.length !== right.factory.ids.length ||
      !same(left.strictContext, right.strictContext)
    )
      different('alias-group');
    for (const [ordinal, moduleId] of left.factory.ids.entries()) {
      const target = right.factory.ids[ordinal];
      if (target === undefined) refuse('alias-group');
      this.bind(
        { runtime: reference.runtime, moduleId },
        { runtime: actual.runtime, moduleId: target },
      );
    }
    this.compareCanonical(reference, actual);
    if (!same(occurrences(reference), occurrences(actual))) different('ports');
    const actPorts = this.ports(actual),
      refPorts = this.ports(reference);
    if (refPorts.length !== actPorts.length) different('ports');
    for (const [ordinal, ref] of refPorts.entries()) {
      const act = actPorts[ordinal];
      if (ref.target.kind !== 'module' || act?.target.kind !== 'module') refuse('resolution');
      this.bind(ref.target, act.target);
    }
    this.leaves(reference, actual);
    this.counts.rows += 1;
    this.counts.ports += left.ports.length;
    this.counts.occurrences += left.ports.reduce((sum, port) => sum + port.occurrences.length, 0);
  }

  run(): void {
    this.bind(this.input.reference.root, this.input.actual.root);
    while (this.pending.length > 0) {
      const pair = this.pending.pop();
      if (pair === undefined) break;
      const [reference, actual] = pair;
      const identity = key(reference);
      if (this.visited.has(identity)) continue;
      this.visited.add(identity);
      this.pair(reference, actual);
    }
    if (this.visited.size !== this.referenceRows.size || this.reverse.size !== this.actualRows.size)
      refuse('closure');
  }
}

/** Inert comparison only: even exact equality never qualifies a catalog or grants a helper role. */
export function compareNodeManifestHandlerGraphs(
  input: NodeManifestHandlerGraphInput,
): NodeManifestHandlerGraphComparison {
  let comparison: Comparison | undefined;
  let result: NodeManifestHandlerGraphComparison['comparison'] = 'equal';
  let reason: Reason | undefined;
  try {
    comparison = new Comparison(input);
    comparison.run();
  } catch (error) {
    if (!(error instanceof MismatchError)) throw error;
    result = error.comparison;
    reason = error.reason;
  }
  return Object.freeze({
    version: 1,
    status: 'UNQUALIFIED',
    comparison: result,
    reason,
    bindings: Object.freeze((comparison?.bindings ?? []).map((binding) => Object.freeze(binding))),
    counts: Object.freeze({
      ...(comparison?.counts ?? { rows: 0, ports: 0, occurrences: 0, leaves: 0, slots: 0 }),
    }),
  });
}
