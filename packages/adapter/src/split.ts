import { stat } from 'node:fs/promises';
import path from 'node:path';

import {
  type Entrypoint,
  type FunctionModuleType,
  PRIMARY_FUNCTION,
} from '@stayingupwind/core/bundle';

import type { RouteCode, ShippedBlob } from './collect.ts';
import { MAX_FUNCTION_BYTES } from './dependencies.ts';
import type { BuiltFunction } from './function.ts';
import {
  type PlanBudget,
  type PlanItem,
  type PlannedFunction,
  planFunctions,
  type PlanUnit,
} from './plan.ts';
import type { ProjectSplit } from './project-config.ts';
import { codeModules } from './source-maps.ts';
import { tracedFiles } from './traced-files.ts';

/**
 * Splitting an application's routes across app Functions: when to, on what budgets, and what each
 * Function of a plan is given.
 *
 * A host has to be able to send each request to the Function its route is in, and to follow a
 * Function that answers that the route is another's (`MISDIRECTED_STATUS`), so nothing here happens
 * unless the host asks for it (`AdapterOptions.functions`). Then the application is first built as
 * one Function, exactly as it would be otherwise, and weighed: within the budgets, that Function is
 * the build, byte for byte. Past them, the routes are planned into as few Functions as the budgets
 * allow (`plan.ts`), weighed with what that one build measured, and each Function is built with its
 * own routes and what every Function needs.
 */

const KIB = 1024;
const MIB = KIB * KIB;

/** What a host that can run an application as several app Functions configures the split with. */
export interface SplitOptions {
  /** The most a Function should weigh, in MiB: past it, the routes are split. At most 64. */
  readonly maxMiB: number;
  /** The most code a Function should carry, in MiB: what its start is spent compiling. */
  readonly maxCodeMiB: number;
  /**
   * Which applications: every one that is past the budgets (`all`, the default), or only those
   * whose own configuration asks for it (`opted-in`) — for a host bringing the split in gradually.
   */
  readonly projects?: 'all' | 'opted-in' | undefined;
}

/** The host's options, refused at configuration rather than at the end of a build. */
export function checkSplitOptions(options: SplitOptions | undefined): void {
  if (options === undefined) {
    return;
  }
  const { maxMiB, maxCodeMiB } = options;
  if (!Number.isFinite(maxMiB) || maxMiB <= 0 || maxMiB * MIB > MAX_FUNCTION_BYTES) {
    throw new RangeError(
      `@stayingupwind/adapter: functions.split.maxMiB must be more than 0 and at most ${String(MAX_FUNCTION_BYTES / MIB)}, got ${String(maxMiB)}`,
    );
  }
  if (!Number.isFinite(maxCodeMiB) || maxCodeMiB <= 0) {
    throw new RangeError(
      `@stayingupwind/adapter: functions.split.maxCodeMiB must be more than 0, got ${String(maxCodeMiB)}`,
    );
  }
}

/**
 * The budgets this build splits on, or `undefined` when it keeps every route in one Function: the
 * host's, tightened by the project's own where it wrote any, and none at all where the host does
 * not split, the project said `false`, or the host splits only projects that ask and this one did
 * not.
 */
export function splitBudget(
  host: SplitOptions | undefined,
  project: ProjectSplit | undefined,
): PlanBudget | undefined {
  if (host === undefined || project === false) {
    return undefined;
  }
  if (project === undefined && host.projects === 'opted-in') {
    return undefined;
  }
  const asked = typeof project === 'object' ? project : {};
  return {
    maxBytes: Math.min(host.maxMiB, asked.maxMiB ?? host.maxMiB) * MIB,
    maxCodeBytes: Math.min(host.maxCodeMiB, asked.maxCodeMiB ?? host.maxCodeMiB) * MIB,
  };
}

/** The module types a Function compiles when it starts. */
const CODE: ReadonlySet<FunctionModuleType> = new Set(['commonjs', 'esm', 'wasm']);

/** What a built Function weighs, and how much of that is code. */
export function weighs(built: BuiltFunction): {
  readonly bytes: number;
  readonly codeBytes: number;
} {
  let bytes = 0;
  let codeBytes = 0;
  for (const module of built.spec.modules) {
    bytes += module.blob.byteLength;
    if (CODE.has(module.type)) {
      codeBytes += module.blob.byteLength;
    }
  }
  return { bytes, codeBytes };
}

export function overBudget(built: BuiltFunction, budget: PlanBudget): boolean {
  const { bytes, codeBytes } = weighs(built);
  return bytes > budget.maxBytes || codeBytes > budget.maxCodeBytes;
}

/**
 * The entrypoints every app Function carries, whatever routes it holds: what answers a request no
 * route of its own does — the not-found page, and the Pages Router's error pages — and the
 * middleware, which a Function runs itself whenever the edge did not.
 */
export const EVERY_FUNCTION: ReadonlySet<string> = new Set([
  '/404',
  '/500',
  '/_error',
  '/_middleware',
  '/_not-found',
]);

/** The Pages Router's kinds: its pages travel together (`unitsOf`). */
const PAGES_ROUTER: ReadonlySet<Entrypoint['kind']> = new Set(['pages', 'pages-api']);

/** What the planner is handed, beyond the routes and the budgets. */
export interface SplitInput {
  readonly routes: readonly RouteCode[];
  readonly shipped: readonly ShippedBlob[];
  /** The application built as one Function: what every piece of its code weighs. */
  readonly single: BuiltFunction;
  /** What every Function reads besides its routes': the middleware's and the hook's traces. */
  readonly baseAssets: readonly Readonly<Record<string, string>>[];
  readonly projectDir: string;
  readonly distDir: string;
  readonly budget: PlanBudget;
}

/** A file's size, or nothing for one that is not there to weigh. */
async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * What the planner weighs pieces with: the bytes each file put into the one Function's code, and
 * every piece named so far; and the blobs each route's prerenders name.
 */
interface Weights {
  readonly code: ReadonlyMap<string, number>;
  readonly items: Map<string, PlanItem>;
  readonly blobsOf: ReadonlyMap<string, readonly string[]>;
}

/**
 * What each byte the bundler reports for a module is worth in the Function. `renderedLength` is a
 * module's code before the output is minified, so the reports add up to more than the code module
 * weighs — 5.6 MiB against a 4.1 MiB `app.cjs`, measured. Scaled to the modules they went into, a
 * route's code is weighed in the bytes it costs a Function to carry.
 */
function inputScale(single: BuiltFunction): number {
  const names = codeModules(PRIMARY_FUNCTION);
  const bundled = single.spec.modules
    .filter((module) => module.name === names.app || module.name === names.edge)
    .reduce((total, module) => total + module.blob.byteLength, 0);
  const reported = single.inputs.reduce((total, each) => total + each.bytes, 0);
  return reported === 0 ? 1 : bundled / reported;
}

function weightsOf(input: SplitInput): Weights {
  const scale = inputScale(input.single);
  const code = new Map(
    input.single.inputs.map((each) => [path.resolve(each.file), Math.round(each.bytes * scale)]),
  );
  const items = new Map<string, PlanItem>();
  const blobsOf = new Map<string, string[]>();
  for (const blob of input.shipped) {
    const name = `b:${blob.sha256}`;
    items.set(name, { bytes: blob.bytes.byteLength, code: false });
    for (const route of blob.routes) {
      const named = blobsOf.get(route) ?? [];
      named.push(name);
      blobsOf.set(route, named);
    }
  }
  return { code, items, blobsOf };
}

/** Every file of a route's code its trace names: what the one Function's code was weighed by. */
function codeFilesOf(route: RouteCode): string[] {
  const files = Object.values(route.assets);
  if (route.edge !== undefined) {
    files.push(...route.edge.files);
  }
  if (route.module !== undefined) {
    files.push(route.module.filePath);
  }
  return files;
}

/** The WebAssembly a route reaches, on either runtime. */
function wasmOf(route: RouteCode): string[] {
  const files = [...route.wasm];
  if (route.edge !== undefined) {
    files.push(...route.edge.wasm.map((asset) => asset.filePath));
  }
  return files;
}

/**
 * The pieces one route needs, by the name the planner weighs them under: the code its trace reaches
 * (`c:`), its WebAssembly (`w:`), the files it reads (`f:`) and the blobs its prerenders name (`b:`).
 */
async function piecesOf(route: RouteCode, input: SplitInput, weights: Weights): Promise<string[]> {
  const pieces: string[] = [];
  for (const file of codeFilesOf(route)) {
    const resolved = path.resolve(file);
    const bytes = weights.code.get(resolved);
    if (bytes !== undefined) {
      pieces.push(`c:${resolved}`);
      weights.items.set(`c:${resolved}`, { bytes, code: true });
    }
  }
  for (const file of wasmOf(route)) {
    const name = `w:${path.resolve(file)}`;
    pieces.push(name);
    weights.items.set(name, { bytes: await sizeOf(file), code: true });
  }
  const read = tracedFiles([{ assets: route.assets }], input.projectDir, input.distDir);
  for (const file of read) {
    const name = `f:${file.name}`;
    pieces.push(name);
    weights.items.set(name, { bytes: await sizeOf(file.filePath), code: false });
  }
  pieces.push(...(weights.blobsOf.get(route.id) ?? []));
  return pieces;
}

/** A trace with no entrypoint behind it — the middleware's, the hook's — as a route to weigh. */
function tracedOnly(assets: Readonly<Record<string, string>>): RouteCode {
  return {
    id: '',
    kind: 'app-route',
    module: undefined,
    edge: undefined,
    chunks: [],
    wasm: [],
    assets,
  };
}

/** What every Function carries anyway: the base routes' pieces, the middleware's, the hook's. */
async function basePieces(input: SplitInput, weights: Weights): Promise<ReadonlySet<string>> {
  const base = new Set<string>();
  const traced = [
    ...input.baseAssets.map((assets) => tracedOnly(assets)),
    ...input.routes.filter((route) => EVERY_FUNCTION.has(route.id)),
  ];
  for (const route of traced) {
    const pieces = await piecesOf(route, input, weights);
    for (const piece of pieces) {
      base.add(piece);
    }
  }
  return base;
}

/**
 * The units the planner places: one per module — entrypoints that share a built file are one
 * module, required once — and one for the whole Pages Router, whose `res.revalidate()` renders any
 * of its pages in the Function that calls it.
 */
function unitsOf(routes: readonly RouteCode[]): RouteCode[][] {
  const units = new Map<string, RouteCode[]>();
  for (const route of routes) {
    if (EVERY_FUNCTION.has(route.id)) {
      continue;
    }
    const key = PAGES_ROUTER.has(route.kind)
      ? 'pages-router'
      : (route.module?.filePath ?? route.edge?.entryKey ?? route.id);
    const unit = units.get(key) ?? [];
    unit.push(route);
    units.set(key, unit);
  }
  return [...units.values()];
}

async function planUnit(
  unit: readonly RouteCode[],
  input: SplitInput,
  weights: Weights,
  base: ReadonlySet<string>,
): Promise<PlanUnit> {
  const pieces = new Set<string>();
  for (const route of unit) {
    const own = await piecesOf(route, input, weights);
    for (const piece of own) {
      if (!base.has(piece)) {
        pieces.add(piece);
      }
    }
  }
  return {
    ids: unit.map((route) => route.id),
    items: [...pieces],
    documents: unit.filter((route) => route.kind === 'app-page' || route.kind === 'pages').length,
  };
}

/**
 * What the one Function weighed beyond what any route can be credited with: what every Function of
 * the plan will weigh — Next.js's own server, the runtime, the manifests, the error pages.
 */
function baseWeight(
  input: SplitInput,
  units: readonly PlanUnit[],
  items: ReadonlyMap<string, PlanItem>,
): { readonly bytes: number; readonly codeBytes: number } {
  let bytes = 0;
  let codeBytes = 0;
  const routed = new Set(units.flatMap((unit) => unit.items));
  for (const name of routed) {
    const item = items.get(name);
    bytes += item?.bytes ?? 0;
    codeBytes += item?.code === true ? item.bytes : 0;
  }
  const single = weighs(input.single);
  return {
    bytes: Math.max(0, single.bytes - bytes),
    codeBytes: Math.max(0, single.codeBytes - codeBytes),
  };
}

/** Plan the Functions this application is split into, weighed on what its one Function measured. */
export async function planSplit(input: SplitInput): Promise<PlannedFunction[]> {
  const weights = weightsOf(input);
  const base = await basePieces(input, weights);
  const units: PlanUnit[] = [];
  for (const unit of unitsOf(input.routes)) {
    units.push(await planUnit(unit, input, weights, base));
  }
  return planFunctions({
    units,
    items: weights.items,
    base: baseWeight(input, units, weights.items),
    budget: input.budget,
  });
}

/** Where each planned route is, by entrypoint id, for the routes outside the first Function. */
export function placementsOf(plan: readonly PlannedFunction[]): ReadonlyMap<string, string> {
  const placements = new Map<string, string>();
  for (const planned of plan) {
    if (planned.name === PRIMARY_FUNCTION) {
      continue;
    }
    for (const id of planned.ids) {
      placements.set(id, planned.name);
    }
  }
  return placements;
}

/** The entrypoints as a split bundle records them: each placed in its Function, the first's unmarked. */
export function placedEntrypoints(
  entrypoints: readonly Entrypoint[],
  placements: ReadonlyMap<string, string>,
): Entrypoint[] {
  return entrypoints.map((entry) => {
    const name = placements.get(entry.id);
    return name === undefined ? entry : { ...entry, function: name };
  });
}

/**
 * The routes one Function of a plan holds, with the ones every Function holds. A route the plan
 * placed nowhere — none should be — is the first Function's, which is where a host sends a request
 * it cannot place.
 */
export function routesOf(
  planned: PlannedFunction,
  routes: readonly RouteCode[],
  placements: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  return new Set(
    routes
      .filter((route) => {
        if (EVERY_FUNCTION.has(route.id)) {
          return true;
        }
        return (placements.get(route.id) ?? PRIMARY_FUNCTION) === planned.name;
      })
      .map((route) => route.id),
  );
}

/**
 * Whether a Function carries a shipped blob: when it holds a route that names it, and — for a blob
 * whose routes have no entrypoint in this build — when it is the first.
 */
export function carriesBlob(
  blob: ShippedBlob,
  held: ReadonlySet<string>,
  known: ReadonlySet<string>,
  primary: boolean,
): boolean {
  return blob.routes.some((route) => (known.has(route) ? held.has(route) : primary));
}

/** The plan as the build's record keeps it: per Function, its routes, and what it was expected to weigh. */
export function planRecord(
  plan: readonly PlannedFunction[],
  budget: PlanBudget,
): Record<string, unknown> {
  return {
    budget: { maxMiB: budget.maxBytes / MIB, maxCodeMiB: budget.maxCodeBytes / MIB },
    functions: plan.map((planned) => {
      return {
        name: planned.name,
        routes: planned.ids,
        expectedMiB: Number((planned.bytes / MIB).toFixed(2)),
        expectedCodeMiB: Number((planned.codeBytes / MIB).toFixed(2)),
      };
    }),
  };
}
