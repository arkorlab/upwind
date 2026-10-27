import { AuditError } from './dependencies.ts';
import { nodeAliasOutsideTrace, OUTSIDE_CLOSED_TRACE } from './node-alias-diagnostics.ts';
import type { NodeSourceSpecifier, NodeSpecifierInventory } from './node-source-specifiers.ts';

// Only these existing resolver refusals mean an alternative supplied no closed layout evidence.
// Unknown AuditErrors, I/O failures and programming errors still propagate.
const UNPROVED_HINTS: ReadonlySet<string> = new Set([
  'Absolute Node module imports cannot be relocated into an artifact',
  'An absolute Node package entry cannot be relocated into an artifact',
  'A Node package alias requires a regular physical target',
  'A relative Node module lookup has no proved physical alias',
  'A relative package entry escapes its closed physical directory',
  'A relative package entry has no closed metadata',
  'Invalid Node package import scope metadata',
  'Native Function relocation changes a relative module or native binary lookup; refusing publication',
  'Node artifact input escapes both its tracing root and build output',
  'Node package export metadata is absent from its physical artifact',
  'Node package export requires an exact regular target',
  'Node package import external alias has no closed physical target',
  'Node package import has an unproved builtin target',
  'Node package import has an unproved external target',
  'Node package import has no closed package scope',
  'Node package import requires a literal target; conditions and chains are unsupported',
  'Node package import requires an exact regular target file',
  'Node package import requires a proved exact mapping; patterns are unsupported',
  'Node package import scope metadata is not closed',
  'Node package import target escapes its package scope',
  'Node package subpath has unproved export or physical topology',
  OUTSIDE_CLOSED_TRACE,
]);

export function unprovedHint(error: unknown): boolean {
  return (
    (error instanceof AuditError && UNPROVED_HINTS.has(error.message)) ||
    (error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR', 'MODULE_NOT_FOUND'].includes(String(error.code)))
  );
}
export function uniqueLoads(
  loads: readonly NodeSourceSpecifier[],
): Map<string, NodeSourceSpecifier> {
  return new Map(loads.map((load) => [`${load.kind}:${load.specifier}`, load]));
}

interface InventoryRow {
  readonly file: string;
  readonly inventory: NodeSpecifierInventory;
}

/** Call-local copied-source inventory only; promotion grants no source or loader authority. */
export class NodeAliasInventory {
  private readonly inventories: ReadonlyMap<string, NodeSpecifierInventory>;
  private readonly strict = new Set<string>();
  private readonly pending: InventoryRow[] = [];
  private position = 0;

  constructor(inventories: ReadonlyMap<string, NodeSpecifierInventory>, seeds: Iterable<string>) {
    this.inventories = new Map(inventories);
    for (const file of seeds) this.promote(file);
  }

  promote(file: string): void {
    const inventory = this.inventories.get(file);
    if (inventory === undefined) throw nodeAliasOutsideTrace(file);
    if (this.strict.has(file)) return;
    this.strict.add(file);
    this.pending.push({ file, inventory });
  }

  next(): InventoryRow | undefined {
    const row = this.pending[this.position];
    this.position += 1;
    return row;
  }

  hints(): readonly { readonly file: string; readonly loads: readonly NodeSourceSpecifier[] }[] {
    const rows = [];
    for (const [file, inventory] of this.inventories) {
      const required = uniqueLoads(inventory.required);
      const loads = uniqueLoads(
        this.strict.has(file)
          ? inventory.alternatives
          : [...inventory.required, ...inventory.alternatives],
      );
      if (this.strict.has(file)) {
        for (const key of required.keys()) loads.delete(key);
      }
      rows.push({ file, loads: [...loads.values()] });
    }
    return rows;
  }
}
