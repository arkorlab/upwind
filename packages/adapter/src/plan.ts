import { MAX_APP_FUNCTIONS } from '@stayingupwind/core/bundle';
import { compareCodeUnits } from '@stayingupwind/core/util';

/**
 * Which routes go into which app Function, for an application too large for one.
 *
 * Every Function a deployment runs as is a Function that starts on its own: the more there are, the
 * more of a site's traffic each one misses, and a Function that is asked less often is a Function
 * that has gone cold more often. A Function holding fewer routes, on the other hand, holds less
 * code, and code is what a Function's start is spent compiling. So the plan makes few Functions
 * within the budgets, and fills each with routes that share their code. Few, not the fewest: the
 * merge below is greedy, and the fewest is a bin-packing problem no build should wait on.
 *
 * 1. Every route starts as a unit of its own. A unit is the smallest thing a Function holds: the
 *    entrypoints that have to travel together (`PlanUnit`).
 * 2. The two units whose union adds the least code to the larger of them are merged, as long as
 *    the result is within both budgets; then the next two, and so on. Routes that share a layout,
 *    its components and its libraries cost nothing to put together, so they are merged first, and
 *    routes that share nothing are merged last, smallest first, while there is still room.
 * 3. It stops when no two units fit together. What is left is the plan: one Function per unit.
 *
 * Nothing here measures anything or reads a file. It is handed what each route is made of and what
 * every piece weighs — the build measured both — and it answers the same for the same input in any
 * order, so a build that changed nothing plans the same Functions.
 */

/** What one piece of a Function weighs, and whether it is code a start has to compile. */
export interface PlanItem {
  readonly bytes: number;
  /** Code and WebAssembly: what a Function's start spends its time on. */
  readonly code: boolean;
}

/** The entrypoints that go into one Function together, and what they are made of. */
export interface PlanUnit {
  /** Entrypoint ids, in any order. */
  readonly ids: readonly string[];
  /** The pieces these entrypoints need beyond what every Function carries anyway (`PlanInput.base`). */
  readonly items: readonly string[];
  /** How many of the ids are documents — pages, rather than route handlers. */
  readonly documents: number;
}

export interface PlanBudget {
  /** The most a Function may weigh, in bytes. */
  readonly maxBytes: number;
  /** The most code a Function may carry, in bytes. */
  readonly maxCodeBytes: number;
}

export interface PlanInput {
  readonly units: readonly PlanUnit[];
  readonly items: ReadonlyMap<string, PlanItem>;
  /** What every Function carries whatever routes it holds: the runtime, the manifests, the error pages. */
  readonly base: { readonly bytes: number; readonly codeBytes: number };
  readonly budget: PlanBudget;
}

/** One Function of a plan, with what the plan expects it to weigh. */
export interface PlannedFunction {
  /** `app` for the first, then `app-2`, `app-3`, … */
  readonly name: string;
  readonly ids: readonly string[];
  readonly bytes: number;
  readonly codeBytes: number;
}

/** A unit, or units merged, as the plan holds it: its pieces as sorted indices, and their weight. */
interface Cluster {
  ids: string[];
  /** Indices into the item table, ascending, without repeats. */
  items: Int32Array;
  bytes: number;
  codeBytes: number;
  documents: number;
  /** The smallest id, which orders clusters and breaks ties. */
  first: string;
}

interface Pair {
  readonly other: number;
  /** Code the merge adds to the larger of the two: what the plan minimizes. */
  readonly added: number;
  /** Code the two share: the more, the better a match, at the same cost. */
  readonly shared: number;
  readonly prefix: number;
}

/** The weight of what two sorted index lists hold between them, and of what they share. */
function overlap(
  a: Int32Array,
  b: Int32Array,
  bytes: Float64Array,
  code: Uint8Array,
): { sharedBytes: number; sharedCode: number } {
  let i = 0;
  let j = 0;
  let sharedBytes = 0;
  let sharedCode = 0;
  while (i < a.length && j < b.length) {
    const x = a[i] ?? 0;
    const y = b[j] ?? 0;
    if (x === y) {
      const weight = bytes[x] ?? 0;
      sharedBytes += weight;
      if (code[x] === 1) {
        sharedCode += weight;
      }
      i += 1;
      j += 1;
    } else if (x < y) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return { sharedBytes, sharedCode };
}

function union(a: Int32Array, b: Int32Array): Int32Array {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = i < a.length ? (a[i] ?? 0) : Infinity;
    const y = j < b.length ? (b[j] ?? 0) : Infinity;
    if (x === y) {
      out.push(x);
      i += 1;
      j += 1;
    } else if (x < y) {
      out.push(x);
      i += 1;
    } else {
      out.push(y);
      j += 1;
    }
  }
  return Int32Array.from(out);
}

/** How many leading path segments two entrypoint ids share: `/a/b/c` and `/a/b/d` share two. */
function commonPrefix(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) {
    shared += 1;
  }
  return shared;
}

/** Whether `a` is the better merge than `b`: less code added, then more shared, then closer paths. */
function better(a: Pair, b: Pair | undefined): boolean {
  if (b === undefined) {
    return true;
  }
  if (a.added !== b.added) {
    return a.added < b.added;
  }
  if (a.shared !== b.shared) {
    return a.shared > b.shared;
  }
  return a.prefix > b.prefix;
}

class Planner {
  readonly #clusters: (Cluster | undefined)[];
  #best: (Pair | undefined)[] = [];
  readonly #bytes: Float64Array;
  readonly #code: Uint8Array;
  readonly #input: PlanInput;
  #budget: PlanBudget;

  constructor(input: PlanInput) {
    this.#input = input;
    const names = [...input.items.keys()].toSorted(compareCodeUnits);
    const index = new Map(names.map((name, at) => [name, at]));
    this.#bytes = Float64Array.from(names, (name) => input.items.get(name)?.bytes ?? 0);
    this.#code = Uint8Array.from(names, (name) => (input.items.get(name)?.code === true ? 1 : 0));
    this.#clusters = input.units
      .map((unit) => this.#clusterOf(unit, index))
      .toSorted((a, b) => compareCodeUnits(a.first, b.first));
    this.#budget = this.#effectiveBudget();
  }

  #clusterOf(unit: PlanUnit, index: ReadonlyMap<string, number>): Cluster {
    const items = Int32Array.from(
      new Set(
        unit.items.flatMap((name) => {
          const at = index.get(name);
          return at === undefined ? [] : [at];
        }),
      ),
    ).toSorted();
    let bytes = 0;
    let codeBytes = 0;
    for (const at of items) {
      const weight = this.#bytes[at] ?? 0;
      bytes += weight;
      if (this.#code[at] === 1) {
        codeBytes += weight;
      }
    }
    const ids = unit.ids.toSorted(compareCodeUnits);
    return { ids, items, bytes, codeBytes, documents: unit.documents, first: ids[0] ?? '' };
  }

  /**
   * The budgets as the plan holds them: as given, except one that no Function could meet — the base
   * and the smallest unit together already past it. Held to the letter, such a budget would let no
   * two units share a Function, and the plan would be a Function per route: the one plan certain to
   * be worse than not splitting at all. It is dropped instead, and the plan made on the other.
   *
   * A unit past a budget that others can meet keeps it: that unit stands in a Function of its own,
   * as small as it can be, and the rest share as the budget allows. The Function's own limit is not
   * this one, and is checked on what is built.
   */
  #effectiveBudget(): PlanBudget {
    const { base, budget } = this.#input;
    let bytes = Infinity;
    let codeBytes = Infinity;
    for (const cluster of this.#clusters) {
      bytes = Math.min(bytes, cluster?.bytes ?? Infinity);
      codeBytes = Math.min(codeBytes, cluster?.codeBytes ?? Infinity);
    }
    return {
      maxBytes: base.bytes + bytes > budget.maxBytes ? Infinity : budget.maxBytes,
      maxCodeBytes:
        base.codeBytes + codeBytes > budget.maxCodeBytes ? Infinity : budget.maxCodeBytes,
    };
  }

  /** The merge of two clusters, if it fits within the budgets. */
  #pair(i: number, j: number): Pair | undefined {
    const a = this.#clusters[i];
    const b = this.#clusters[j];
    if (a === undefined || b === undefined) {
      return undefined;
    }
    const { sharedBytes, sharedCode } = overlap(a.items, b.items, this.#bytes, this.#code);
    const { base } = this.#input;
    const budget = this.#budget;
    const bytes = a.bytes + b.bytes - sharedBytes;
    const codeBytes = a.codeBytes + b.codeBytes - sharedCode;
    if (base.bytes + bytes > budget.maxBytes || base.codeBytes + codeBytes > budget.maxCodeBytes) {
      return undefined;
    }
    return {
      other: j,
      added: codeBytes - Math.max(a.codeBytes, b.codeBytes),
      shared: sharedCode,
      prefix: commonPrefix(a.first, b.first),
    };
  }

  /** The best merge for one cluster among all the others. */
  #bestFor(i: number): Pair | undefined {
    let best: Pair | undefined;
    for (let j = 0; j < this.#clusters.length; j += 1) {
      if (j === i || this.#clusters[j] === undefined) {
        continue;
      }
      const pair = this.#pair(i, j);
      if (pair !== undefined && better(pair, best)) {
        best = pair;
      }
    }
    return best;
  }

  #merge(i: number, j: number): void {
    const a = this.#clusters[i];
    const b = this.#clusters[j];
    if (a === undefined || b === undefined) {
      return;
    }
    const items = union(a.items, b.items);
    let bytes = 0;
    let codeBytes = 0;
    for (const at of items) {
      const weight = this.#bytes[at] ?? 0;
      bytes += weight;
      if (this.#code[at] === 1) {
        codeBytes += weight;
      }
    }
    const ids = [...a.ids, ...b.ids].toSorted(compareCodeUnits);
    this.#clusters[i] = {
      ids,
      items,
      bytes,
      codeBytes,
      documents: a.documents + b.documents,
      first: ids[0] ?? '',
    };
    this.#clusters[j] = undefined;
    this.#best[j] = undefined;
  }

  /** The best merge there is, as the cluster it is the best partner of and the pair. */
  #chosen(): { readonly at: number; readonly pair: Pair } | undefined {
    let chosen: { at: number; pair: Pair } | undefined;
    for (const [at, pair] of this.#best.entries()) {
      if (pair !== undefined && better(pair, chosen?.pair)) {
        chosen = { at, pair };
      }
    }
    return chosen;
  }

  /**
   * After `merged` absorbed `absorbed`: a cluster's best partner may have been either of the two,
   * and the merged cluster may now be the best partner of any other, so everything whose answer
   * could have changed is asked again.
   */
  #refresh(merged: number, absorbed: number): void {
    for (const [at, best] of this.#best.entries()) {
      if (this.#clusters[at] === undefined) {
        continue;
      }
      if (at === merged || best === undefined || best.other === merged || best.other === absorbed) {
        this.#best[at] = this.#bestFor(at);
        continue;
      }
      const pair = this.#pair(at, merged);
      if (pair !== undefined && better(pair, best)) {
        this.#best[at] = pair;
      }
    }
  }

  /** Merge while a merge is possible, or — `limit` — while there are more clusters than that. */
  #mergeWhile(limit: number): void {
    this.#best = this.#clusters.map((_, at) => this.#bestFor(at));
    let alive = this.#clusters.filter((cluster) => cluster !== undefined).length;
    for (
      let chosen = this.#chosen();
      chosen !== undefined && alive > limit;
      chosen = this.#chosen()
    ) {
      this.#merge(chosen.at, chosen.pair.other);
      this.#refresh(chosen.at, chosen.pair.other);
      alive -= 1;
    }
  }

  run(): Cluster[] {
    this.#mergeWhile(1);
    // A deployment runs as at most so many Functions (`MAX_APP_FUNCTIONS`): past it, the cheapest
    // merges go on whatever the budgets say, since a plan the bundle cannot carry is no plan.
    if (this.#clusters.filter((cluster) => cluster !== undefined).length > MAX_APP_FUNCTIONS) {
      this.#budget = { maxBytes: Infinity, maxCodeBytes: Infinity };
      this.#mergeWhile(MAX_APP_FUNCTIONS);
    }
    return this.#clusters.filter((cluster): cluster is Cluster => cluster !== undefined);
  }
}

/** The cluster a request nothing else places goes to: the most documents, then the most code, then the smallest id. */
function primaryOf(clusters: readonly Cluster[]): Cluster | undefined {
  let primary: Cluster | undefined;
  for (const cluster of clusters) {
    if (
      primary === undefined ||
      cluster.documents > primary.documents ||
      (cluster.documents === primary.documents && cluster.codeBytes > primary.codeBytes)
    ) {
      primary = cluster;
    }
  }
  return primary;
}

/**
 * The Functions to build, the first being the one that holds the most documents (ties: the more
 * code, then the smallest id) — the one a request nothing else places goes to — and the rest named
 * in the order of their smallest entrypoint id. One Function when everything fits in one.
 */
export function planFunctions(input: PlanInput): PlannedFunction[] {
  // In the order of their smallest id, so the first of equals is the one with the smallest.
  const clusters = new Planner(input).run().toSorted((a, b) => compareCodeUnits(a.first, b.first));
  const primary = primaryOf(clusters);
  const rest = clusters
    .filter((cluster) => cluster !== primary)
    .toSorted((a, b) => compareCodeUnits(a.first, b.first));
  const ordered = primary === undefined ? rest : [primary, ...rest];
  return ordered.map((cluster, at) => {
    return {
      name: at === 0 ? 'app' : `app-${String(at + 1)}`,
      ids: cluster.ids,
      bytes: input.base.bytes + cluster.bytes,
      codeBytes: input.base.codeBytes + cluster.codeBytes,
    };
  });
}
