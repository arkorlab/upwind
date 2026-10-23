import type { ScopeHistory } from './history.ts';
import { initializeScope, scopeName } from './mutations.ts';
import { readScope } from './state.ts';

/** Table presence and the immutable build identity travel together for this object instance. */
export class ScopeContext {
  readonly #ctx: DurableObjectState;
  #buildId: string | undefined;
  #packSchemaVersion: 1 | 2 = 1;
  #repairNamespace: string | undefined;
  tables: boolean;

  constructor(ctx: DurableObjectState, history: ScopeHistory) {
    this.#ctx = ctx;
    this.tables = initializeScope(ctx.storage.sql, Date.now(), history);
    this.#hydrateBuildId();
  }

  #hydrateBuildId(): void {
    if (!this.tables || this.#buildId !== undefined) return;
    const scope = readScope(this.#ctx.storage.sql);
    if (scope?.scope_id === this.scopeId) {
      this.#buildId = scope.build_id;
      this.#packSchemaVersion = scope.pack_schema_version === 2 ? 2 : 1;
      this.#repairNamespace =
        typeof scope.repair_namespace === 'string' ? scope.repair_namespace : undefined;
    }
  }

  get scopeId(): string {
    return scopeName(this.#ctx);
  }

  get buildId(): string | undefined {
    return this.#buildId;
  }

  get packSchemaVersion(): 1 | 2 {
    return this.#packSchemaVersion;
  }

  get repairNamespace(): string | undefined {
    return this.#repairNamespace;
  }

  /** A first seed persisted its scope row before any settle can project its generations. */
  committed(tables: boolean): void {
    this.tables = tables;
    this.#hydrateBuildId();
  }

  /** Only successful storage erasure gives up the immutable identity. */
  erased(): void {
    this.#buildId = undefined;
    this.#packSchemaVersion = 1;
    this.#repairNamespace = undefined;
  }
}
