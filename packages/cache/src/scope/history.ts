import type { CacheEventEntityType, CacheEventKind } from '@stayingupwind/host/cache';

import type { CacheBindings } from '../bindings.ts';
import type { BlobStore, TestFaults } from './io.ts';

/**
 * A scope's history, as a host keeps it: what each change did, kept for whatever reads it back.
 * The cache keeps none of its own — `NO_HISTORY` keeps nothing — and nothing it serves from waits on
 * one: a change appends what it did inside its own transaction, synchronously, and what is
 * published of that is published once the change is answered (`settlePending`).
 *
 * A change says what it did whether or not anything keeps it. Saying it reads back the rows the
 * change wrote, which refuses a change whose rows would not read, and a change that says nothing
 * commits no revision; neither may depend on whether a host listens.
 */

/** A change the authority made, as a scope's history is told it. */
export interface EventInput {
  readonly entityType: CacheEventEntityType;
  readonly entityId: string;
  readonly kind: CacheEventKind;
  readonly payload: unknown;
}

/** Where a change is told: in its transaction, at the revision it commits at, at its clock. */
export interface EventContext {
  readonly sql: SqlStorage;
  readonly revision: number;
  readonly now: number;
}

/** What a history publishes with once a change is answered: the settle run's own. */
export interface HistoryDeps {
  readonly sql: SqlStorage;
  readonly scopeId: string;
  readonly blobs: BlobStore;
  readonly now: () => number;
  readonly transaction: <T>(body: () => T) => T;
  /** Whether another run is waiting for this one, which the history may leave its share to. */
  readonly othersWaiting: () => boolean;
}

export type Settled = PromiseSettledResult<void>;

/** A value a history says in an answer, as an RPC carries it: plain, or one object of plain. */
type Plain = string | number | boolean | null | undefined;

/** What a history says of itself in an answer: fields beside the authority's own. */
export type HistoryFields = Readonly<Record<string, Plain | Readonly<Record<string, Plain>>>>;

/** What a run that publishes nothing reports of it: two parts, both done. */
export const NOTHING_PUBLISHED: readonly [Settled, Settled] = [
  { status: 'fulfilled', value: undefined },
  { status: 'fulfilled', value: undefined },
];

/**
 * One scope object's history (`CacheScope.historyOf`). Every method but `publish` is synchronous and
 * runs inside the object's own transactions, or reads beside them; `publish` runs after an answer.
 */
export interface ScopeHistory {
  /** Tables the history keeps beside the scope's own, made after them; each statement idempotent. */
  readonly schema: readonly string[];
  /** The object is up and holds a scope's tables: what an older version left undecided is decided. */
  open(sql: SqlStorage, now: number): void;
  /** The scope is seeded, before its first change is told; `seed` is what it was seeded with. */
  begin(sql: SqlStorage, seed: HistoryFields): void;
  /** A seed found the scope seeded already, for the same deployment and build. */
  reseed(sql: SqlStorage, seed: HistoryFields, now: number): void;
  /** What a seed's answer says of the history, beside the scope's revision. */
  seeded(sql: SqlStorage): HistoryFields;
  /** Whether a change's own words are kept: what a regeneration observed, the write it metered. */
  records(sql: SqlStorage): boolean;
  /** Whether what the history names is kept to be read back, which retention keeps longer. */
  keeps(sql: SqlStorage): boolean;
  /** Tell one change, inside its transaction. */
  append(context: EventContext, event: EventInput): void;
  /** Whether anything told is not published yet: a settle run is owed for it. */
  owes(sql: SqlStorage): boolean;
  /**
   * Publish what was told, after the change is answered: what is owed in storage, then what is owed
   * beyond it — or leave both to the run waiting behind this one.
   */
  publish(deps: HistoryDeps): Promise<readonly [Settled, Settled]>;
  /** Let go of what is past `before`; the storage keys only it named, for the caller to delete. */
  ageOut(sql: SqlStorage, before: number): string[];
  /** Stop keeping it, for good, as the host asks (`ensureRetention`); what came of that. */
  stop(storage: DurableObjectStorage, now: number, epoch: number | undefined): HistoryFields;
  /** What a reader of the scope's head is told of the history (`readHead`). */
  head(sql: SqlStorage): HistoryFields;
}

const NOTHING: HistoryFields = {};

/** How a scope's object makes its history, from its environment and its test faults. */
export type HistoryFactory = (env: CacheBindings, faults: () => TestFaults) => ScopeHistory;

/** A host that keeps no history: every change is said and nothing of it kept. */
export const NO_HISTORY: ScopeHistory = {
  schema: [],
  open() {
    // Nothing was kept by an older version either.
  },
  begin() {
    // Nothing is kept of the scope.
  },
  reseed() {
    // Nor of a seed made again.
  },
  seeded: () => NOTHING,
  records: () => false,
  keeps: () => false,
  append() {
    // Told, and let go.
  },
  owes: () => false,
  publish: () => Promise.resolve(NOTHING_PUBLISHED),
  ageOut: () => [],
  stop: () => NOTHING,
  head: () => NOTHING,
};
