/**
 * What this isolate has been told its deployments invalidated at once, by scope
 * (`cache/condemned.ts`): for each tag, the latest revision of the scope an at-once invalidation of
 * it was recorded at, and a revision below which every tagged record of the scope goes — an
 * invalidation of every tag, or the tags folded into one bound.
 *
 * Kept an hour from a scope's latest invalidation, for as long as anything may still answer with a
 * record from before it: KV, until the record that replaced it has reached every data center
 * (`KV_ANSWER_HELD_MS` and its propagation), and a data center's copy, which answers for no longer
 * than `LONGEST_COPY_AGE_MS` whatever a policy asks. Forgetting one sooner could let a condemned
 * record be served again, so nothing is forgotten sooner for want of room until folding can make no
 * more. A scope that names too many tags is folded into its floor, which condemns at least what they
 * did; an isolate that holds too much folds the scopes that still list tags, oldest first, and
 * forgets the oldest only once every scope is folded and it still holds too much. A scope forgotten
 * so is told of (`forgotten`), so that what told the isolate of it is taken in again: an answer of
 * the authority's that says nothing moved past what the isolate knew would take in no window
 * (`cache/scope-signal.ts`).
 */

/** A scope's at-once invalidations, as `condemnationOf` reads them, and the ones with a window. */
export interface ScopeInvalidations {
  /** For each tag, the revision a record carrying it must be at to stand. */
  readonly tags: ReadonlyMap<string, number>;
  /** The revision every tagged record must be at to stand, where there is one. */
  readonly every: number | undefined;
  /**
   * For each tag invalidated with a window (`revalidateTag(tag, 'max')`), the revision a record
   * carrying it must be at to be fresh: one before it may still be served, and only by the
   * Function, which serves it stale and regenerates it behind (`condemnedIn`). Heard of from the
   * authority (`cache/scope-signal.ts`); a response says only what it invalidated at once.
   */
  readonly stale: ReadonlyMap<string, number>;
}

const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
/**
 * How long past a copy's own life a record from before an invalidation may still be kept as one: KV
 * confirms the record it replaced, and a copy is kept again, only until the replacement has reached
 * every data center — its cache there (`KV_ANSWER_HELD_MS`) and its propagation, with room to spare.
 */
const KV_SETTLES_MINUTES = 10;
const KV_SETTLES_MS = KV_SETTLES_MINUTES * MINUTE_MS;
/**
 * The longest a data center's copy of a record answers, whatever a policy's
 * `runtimeCache.cacheApiMaxAgeMs` asks (`copyMaxAgeMs`, in `cache/generation-loader.ts`). An
 * invalidation is kept for this and KV's settling past it, so no copy from before one outlives what
 * condemns it — under whichever policy kept it: a scope's policy can be promoted, and promoted back,
 * so the copies there now may be under another's than the one an invalidation came under.
 */
export const LONGEST_COPY_AGE_MS = (MINUTES_PER_HOUR - KV_SETTLES_MINUTES) * MINUTE_MS;
/** How long a scope's invalidations are kept from its latest: an hour. */
const KEPT_MS = LONGEST_COPY_AGE_MS + KV_SETTLES_MS;
/** The most tags one scope lists before they are folded into its floor. */
const MAX_TAGS_PER_SCOPE = 64;
const KIB = 1024;
/** What the isolate holds of them, at most, before it folds and then forgets: a MiB. */
const MAX_BYTES = KIB * KIB;
/** What a scope is charged on its own, and each tag besides its characters. */
const SCOPE_BYTES = 64;
const TAG_BYTES = 16;
/** The two numbers and object of a response's revision, held within the scope's own budget. */
const RESPONSE_REVISION_BYTES = 48;
/** The Function catches up only with a recent invalidation (`cache/pulls.ts` in the runtime). */
const RESPONSE_REVISION_MINUTES = 10;
const RESPONSE_REVISION_MS = RESPONSE_REVISION_MINUTES * MINUTE_MS;

interface ResponseRevision {
  readonly revision: number;
  /** When this isolate first received this revision, not when an authority copy was read. */
  readonly observedAt: number;
}

interface Kept {
  readonly invalidations: ScopeInvalidations;
  readonly bytes: number;
  /** When its latest invalidation was taken in. */
  readonly at: number;
  /** A legacy response named no revision, so a transfer must drop held records conservatively. */
  readonly unbounded: boolean;
  /** A response's acknowledged revision, separate from the authority's complete tag view. */
  readonly responseRevision: ResponseRevision | undefined;
}

interface KeepOptions {
  readonly at?: number | undefined;
  readonly unbounded?: boolean | undefined;
  readonly responseRevision?: ResponseRevision | undefined;
}

/** What the tags of a bound charge, besides their scope's own. */
function tagBytes(tags: Iterable<string>): number {
  let bytes = 0;
  for (const tag of tags) {
    bytes += TAG_BYTES + tag.length * 2;
  }
  return bytes;
}

function bytesOf(invalidations: ScopeInvalidations, responseRevision?: ResponseRevision): number {
  return (
    SCOPE_BYTES +
    tagBytes(invalidations.tags.keys()) +
    tagBytes(invalidations.stale.keys()) +
    (responseRevision === undefined ? 0 : RESPONSE_REVISION_BYTES)
  );
}

/** Keep a revision and its first observation together, including across a scope transfer. */
function laterResponse(
  before: ResponseRevision | undefined,
  after: ResponseRevision | undefined,
): ResponseRevision | undefined {
  if (before === undefined) return after;
  if (after === undefined || after.revision < before.revision) return before;
  if (after.revision > before.revision) return after;
  return before.observedAt <= after.observedAt ? before : after;
}

/**
 * Every tag's bound folded into one floor, a window's as well as an at-once one's: it condemns at
 * least what they did, and holds nothing.
 */
function folded(invalidations: ScopeInvalidations): ScopeInvalidations {
  if (invalidations.tags.size === 0 && invalidations.stale.size === 0) {
    return invalidations;
  }
  const every = Math.max(
    ...invalidations.tags.values(),
    ...invalidations.stale.values(),
    invalidations.every ?? 0,
  );
  return { tags: new Map(), every, stale: new Map() };
}

function latest(revision: number, before: number | undefined): number {
  return before === undefined ? revision : Math.max(before, revision);
}

/** `before` with `tags` — every tag, where `undefined` — bound to `revision` at the least. */
function bound(
  before: ScopeInvalidations,
  tags: readonly string[] | undefined,
  revision: number,
): ScopeInvalidations {
  if (tags === undefined) {
    return { tags: before.tags, every: latest(revision, before.every), stale: before.stale };
  }
  const merged = new Map(before.tags);
  for (const tag of tags) {
    merged.set(tag, latest(revision, merged.get(tag)));
  }
  return { tags: merged, every: before.every, stale: before.stale };
}

/** `bounds` taken into `into`, each tag at the latest revision either names. */
function boundEach(
  into: ReadonlyMap<string, number>,
  bounds: readonly TagBound[],
): Map<string, number> {
  const merged = new Map(into);
  for (const { tag, revision } of bounds) {
    merged.set(tag, latest(revision, merged.get(tag)));
  }
  return merged;
}

function entriesOf(bounds: ReadonlyMap<string, number>): TagBound[] {
  return [...bounds].map(([tag, revision]) => ({ tag, revision }));
}

/** A tag, and the revision of the invalidation that bounds it. */
export interface TagBound {
  readonly tag: string;
  readonly revision: number;
}

export class InvalidationMemory {
  readonly #now: () => number;
  readonly #maxBytes: number;
  readonly #forgotten: ((scopeId: string) => void) | undefined;
  /** In the order their latest invalidations were taken in, oldest first. */
  readonly #scopes = new Map<string, Kept>();
  #bytes = 0;

  /**
   * `forgotten` is told of each scope whose invalidations are forgotten for want of room while they
   * are still kept; not of one past its keeping, nor of one folded, which condemns at least as much.
   */
  constructor(
    now: () => number,
    maxBytes: number = MAX_BYTES,
    forgotten?: (scopeId: string) => void,
  ) {
    this.#now = now;
    this.#maxBytes = maxBytes;
    this.#forgotten = forgotten;
  }

  #drop(scopeId: string): void {
    const kept = this.#scopes.get(scopeId);
    if (kept !== undefined) {
      this.#bytes -= kept.bytes;
      this.#scopes.delete(scopeId);
    }
  }

  /**
   * Make room: forget what is past its keeping; then fold the scopes that still list tags, oldest
   * first; and only then forget the oldest.
   */
  #fit(): void {
    const now = this.#now();
    for (const [scopeId, kept] of this.#scopes) {
      if (this.#bytes <= this.#maxBytes || now - kept.at < KEPT_MS) {
        break;
      }
      this.#drop(scopeId);
    }
    for (const [scopeId, kept] of this.#scopes) {
      if (this.#bytes <= this.#maxBytes) {
        return;
      }
      const smaller = folded(kept.invalidations);
      const bytes = bytesOf(smaller, kept.responseRevision);
      this.#bytes += bytes - kept.bytes;
      this.#scopes.set(scopeId, { ...kept, invalidations: smaller, bytes });
    }
    for (const scopeId of this.#scopes.keys()) {
      if (this.#bytes <= this.#maxBytes) {
        return;
      }
      this.#drop(scopeId);
      this.#forgotten?.(scopeId);
    }
  }

  #kept(scopeId: string): Kept | undefined {
    const kept = this.#scopes.get(scopeId);
    if (kept !== undefined && this.#now() - kept.at >= KEPT_MS) {
      this.#drop(scopeId);
      return undefined;
    }
    return kept;
  }

  #before(scopeId: string): ScopeInvalidations {
    return (
      this.#kept(scopeId)?.invalidations ?? {
        tags: new Map<string, number>(),
        every: undefined,
        stale: new Map<string, number>(),
      }
    );
  }

  /** Keep `after` as the scope's, folded past the bound, and make room for it. */
  #keep(
    scopeId: string,
    after: ScopeInvalidations,
    {
      at,
      unbounded = false,
      responseRevision = this.#kept(scopeId)?.responseRevision,
    }: KeepOptions = {},
  ): void {
    const kept: Kept = {
      invalidations:
        after.tags.size + after.stale.size > MAX_TAGS_PER_SCOPE ? folded(after) : after,
      bytes: 0,
      at: at ?? this.#now(),
      unbounded: unbounded || this.#kept(scopeId)?.unbounded === true,
      responseRevision,
    };
    const sized: Kept = {
      ...kept,
      bytes: bytesOf(kept.invalidations, kept.responseRevision),
    };
    this.#drop(scopeId);
    if (at === undefined) {
      this.#scopes.set(scopeId, sized);
    } else {
      // A transfer keeps its original age. Insert it before newer scopes so room is still made
      // oldest first; ordinary invalidations append in constant time as before.
      const newer = [...this.#scopes].filter(([, entry]) => entry.at > at);
      for (const [id] of newer) this.#scopes.delete(id);
      this.#scopes.set(scopeId, sized);
      for (const [id, entry] of newer) this.#scopes.set(id, entry);
    }
    this.#bytes += sized.bytes;
    this.#fit();
  }

  /** What the scope's at-once invalidations condemn, while they are kept. */
  of(scopeId: string): ScopeInvalidations | undefined {
    return this.#kept(scopeId)?.invalidations;
  }

  /**
   * A response's recent acknowledged revision: a lower bound the next Function must catch up to,
   * not a claim that this edge holds the complete invalidation view through it. Past the runtime's
   * catch-up window, send no hint: it would suppress the Function's own nearby revision lookup.
   */
  responseRevisionOf(scopeId: string): ResponseRevision | undefined {
    const response = this.#kept(scopeId)?.responseRevision;
    return response !== undefined && this.#now() - response.observedAt <= RESPONSE_REVISION_MS
      ? response
      : undefined;
  }

  /** Move provisional bounds to the manifest's scope, without renewing their lifetime. */
  move(from: string, to: string): 'none' | 'bounded' | 'unbounded' {
    if (from === to) return 'none';
    const source = this.#kept(from);
    if (source === undefined) return 'none';
    const destination = this.#kept(to);
    const into = this.#before(to);
    const every = source.invalidations.every;
    const after: ScopeInvalidations = {
      tags: boundEach(into.tags, entriesOf(source.invalidations.tags)),
      stale: boundEach(into.stale, entriesOf(source.invalidations.stale)),
      every: every === undefined ? into.every : latest(every, into.every),
    };
    this.#drop(from);
    this.#keep(to, after, {
      at: Math.max(source.at, destination?.at ?? source.at),
      unbounded: source.unbounded,
      responseRevision: laterResponse(destination?.responseRevision, source.responseRevision),
    });
    return source.unbounded ? 'unbounded' : 'bounded';
  }

  /**
   * From when an absence KV answered for the scope may be held: past its latest at-once
   * invalidation by as long as KV may still answer with what it held before it (`KV_SETTLES_MS`) —
   * an answer that there is no record carries no revision to tell it by. `undefined` while none is
   * kept.
   */
  absencesHeldFrom(scopeId: string): number | undefined {
    const at = this.#kept(scopeId)?.at;
    return at === undefined ? undefined : at + KV_SETTLES_MS;
  }

  /**
   * Take in an at-once invalidation of `tags`, or of every tag, recorded at `revision`. One whose
   * revision was not said bounds no record, and is kept only for when it came (`absencesHeldFrom`).
   */
  take(scopeId: string, tags: readonly string[] | undefined, revision: number | undefined): void {
    const before = this.#before(scopeId);
    this.#keep(scopeId, revision === undefined ? before : bound(before, tags, revision), {
      unbounded: revision === undefined,
    });
  }

  /**
   * What a Function's response confirms the authority recorded. Reads, legacy notifications and
   * equal or older acknowledgements never renew the first observation of a revision.
   */
  takeResponse(
    scopeId: string,
    tags: readonly string[] | undefined,
    revision: number | undefined,
  ): void {
    const before = this.#before(scopeId);
    const response =
      revision === undefined || revision === 0 ? undefined : { revision, observedAt: this.#now() };
    this.#keep(scopeId, revision === undefined ? before : bound(before, tags, revision), {
      unbounded: revision === undefined,
      responseRevision: laterResponse(this.#kept(scopeId)?.responseRevision, response),
    });
  }

  /**
   * Take in what the authority says the scope's recent invalidations were (`cache/scope-signal.ts`):
   * each at-once one, and each with a window, bound to its own revision.
   */
  takeEach(
    scopeId: string,
    bounds: { readonly atOnce: readonly TagBound[]; readonly windowed: readonly TagBound[] },
  ): void {
    const before = this.#before(scopeId);
    this.#keep(scopeId, {
      tags: boundEach(before.tags, bounds.atOnce),
      every: before.every,
      stale: boundEach(before.stale, bounds.windowed),
    });
  }

  /** What it holds, as charged. */
  get usedBytes(): number {
    return this.#bytes;
  }
}
