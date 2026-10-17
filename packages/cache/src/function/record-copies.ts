import { sha256HexOfText } from '@stayingupwind/core/artifact';
import { readBoundedBody, releaseStream } from '@stayingupwind/core/util';

import { cacheStorage, type FunctionCacheNaming, turnsOfRequest, within } from './artifacts.ts';
import type { ReadBudget } from './read-budget.ts';

/**
 * The data center's copy of each delivery record this Function's commits wrote, read where KV is
 * behind it.
 *
 * A Function reads an entry's record from KV in its own data center (the read gateway), which keeps
 * an answer there for half a minute — the record, or that there is none — and longer still while a
 * write is on its way to that data center. A regeneration one isolate published is read by no other
 * isolate of the data center until that answer goes: each judges the entry missing, stale or
 * expired, renders it again, and requests made one after the other are answered with renders that
 * disagree. So the authority hands a commit the record its settle wrote, and the Function keeps it
 * in its data center's Cache API too, for a little longer than KV keeps an answer; the runtime asks
 * for it (`readNewerRecord`) only of an entry its read found missing or no longer fresh, and takes
 * it only when it is a later generation than the one read.
 *
 * Each copy carries the sequence of the generation it holds, so a read tells a later one from an
 * earlier one before it reads the body, and a write leaves a later generation's copy as it is: two
 * commits of one entry in one data center can land their copies out of order, and the earlier one's
 * neither takes the later one's place nor lets it go. The Cache API has no compare-and-set, so two
 * writes in the same moment can still cross, and KV puts it right in time.
 *
 * Kept under a key derived with the scope's token, as the data copies are: anything that opens the
 * copies' cache could otherwise plant a record under an entry's id. What a copy holds is checked as
 * any record is before it is served (`recordPackOf`).
 *
 * A copy is read whole, as a record the gateway answers is, and every request KV is behind on reads
 * one: an isolate reads no more of them at once than it has room for, in the room it reads records
 * and artifacts in (`ReadBudget`). A copy takes its room once its lookup has answered, before its
 * body is read, and gives it back once the body is read or given up; one that has no room within
 * its read's time is not read, and the request goes on as it would with no copy.
 */

/**
 * Past KV's own keeping of an answer (30 s) and its propagation, with room for the copy to be read
 * before it goes; a copy behind KV is never taken (`find`), so a longer life costs nothing.
 */
const RECORD_COPY_MAX_AGE_SECONDS = 120;
const KIB = 1024;
const MIB = KIB * KIB;
const MAX_RECORD_COPY_MIB = 4;
/**
 * The largest copy kept: what the authority hands a commit back at the most. A copy is read whole,
 * and what the Cache API holds under the key could have been put there by anything that opens the
 * copies' cache, so a body past this is not read on. It is the room a copy that does not say its
 * length is read in.
 */
const MAX_RECORD_COPY_BYTES = MAX_RECORD_COPY_MIB * MIB;
/**
 * How long a read waits on the copy, its lookup, its room and its body together: a render costs
 * more.
 */
const RECORD_COPY_READ_MS = 100;
/**
 * How long a write waits, its turn included, for the Cache API to take the copy. It is behind the
 * response, whose end waits for it (`RequestWrites`), so a Cache API that stalls costs no more.
 */
const RECORD_COPY_WRITE_MS = 1000;
/**
 * How much of that a write waits for its turn. Past it no copy is kept, and an earlier one is let go
 * of all the same, without a turn, in what is left of the write's second (`#write`).
 */
const RECORD_COPY_TURN_MS = RECORD_COPY_WRITE_MS / 2;
/** The sequence of the generation a copy holds, read before its body. */
const SEQ_HEADER = 'x-arkor-seq';
/**
 * The revision of the record a copy holds, read with its sequence: an invalidation rewrites a
 * generation's record without moving its sequence, and two copies of one generation are told apart
 * by it.
 */
const RECORD_REVISION_HEADER = 'x-arkor-record-revision';

function warn(message: string, detail: unknown): void {
  // The Function's own log, as the runtime writes its own: nothing else sees what its cache did.
  // eslint-disable-next-line no-console
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: `cache-host: ${message}`,
      detail: detail instanceof Error ? detail.message : String(detail),
    }),
  );
}

/** The whole number a copy's header `name` says; `undefined` for none, or none that reads. */
function countOf(response: Response, name: string): number | undefined {
  const value = response.headers.get(name);
  if (value === null || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

/**
 * What is left of the time of a read begun at `startedAt` (`RECORD_COPY_READ_MS`): one time for the
 * lookup, the wait for room and the body together, so what each took is the next's no longer.
 */
function leftOf(startedAt: number): number {
  return RECORD_COPY_READ_MS - (Date.now() - startedAt);
}

/** The sequence a copy says it holds; `undefined` for one that says none, or none that reads. */
function seqOf(response: Response): number | undefined {
  return countOf(response, SEQ_HEADER);
}

/** Which record a copy holds: its generation's sequence, and the record's revision. */
export interface RecordOf {
  readonly seq: number;
  readonly revision: number;
}

/** Whether `held` is a later record than `than`: a later generation's, or a later revision's. */
function laterThan(held: RecordOf, than: RecordOf): boolean {
  return held.seq > than.seq || (held.seq === than.seq && held.revision > than.revision);
}

/**
 * The record the copy under `key` holds, read without its body; none where there is none, or none
 * that says its sequence. A copy that says no revision is taken for the earliest of its generation.
 */
async function standingOf(cache: Cache, key: string): Promise<RecordOf | undefined> {
  const standing = await cache.match(key);
  if (standing === undefined) {
    return undefined;
  }
  releaseStream(standing.body, 'a record copy looked at for its sequence');
  const seq = seqOf(standing);
  return seq === undefined
    ? undefined
    : { seq, revision: countOf(standing, RECORD_REVISION_HEADER) ?? 0 };
}

/** Let go of what a lookup given up on answers with, once it does. */
async function releaseLate(lookup: Promise<Response | undefined>): Promise<void> {
  const late = await lookup;
  releaseStream(late?.body, 'a record copy that came too late');
}

/** The scope whose copies these are, and the token that opens it. */
interface CopiesScope {
  readonly scopeId: string;
  readonly token: string;
}

/** The data center's Cache API, under the copies' cache and a key of this scope's own. */
export class RecordCopies {
  /**
   * The copies of this scope, where the Worker has a Cache API: none under Node.js. Read in
   * `budget`, the isolate's room for what it reads whole.
   */
  static of(
    naming: FunctionCacheNaming,
    scope: CopiesScope,
    budget: ReadBudget,
  ): RecordCopies | undefined {
    const storage = cacheStorage();
    return storage === undefined ? undefined : new RecordCopies(storage, naming, scope, budget);
  }

  readonly #storage: CacheStorage;
  readonly #naming: FunctionCacheNaming;
  readonly #scopeId: string;
  readonly #token: string;
  readonly #budget: ReadBudget;

  constructor(
    storage: CacheStorage,
    naming: FunctionCacheNaming,
    scope: CopiesScope,
    budget: ReadBudget,
  ) {
    this.#storage = storage;
    this.#naming = naming;
    this.#scopeId = scope.scopeId;
    this.#token = scope.token;
    this.#budget = budget;
  }

  async #keyOf(entryId: string): Promise<string> {
    const secret = await sha256HexOfText(`${this.#token}|record|${entryId}`);
    return `${this.#naming.copyKeyOrigin}/records/${encodeURIComponent(this.#scopeId)}/${secret}`;
  }

  /**
   * Put the copy of the record `change` names — or, given no record, let go of a copy of an earlier
   * record than it — in one of the request's turns, as a data copy is written
   * (`COPY_WRITES_AT_ONCE`). Records are ordered by generation, then by revision (`laterThan`): an
   * invalidation rewrites a generation's record without moving its sequence. A copy of a later
   * record is left as it is either way — a write that took long could otherwise land over it, or
   * take it away. A put the Cache API refuses lets go of the entry's copy as well, which is no later
   * than this one. A write that has no turn within `RECORD_COPY_TURN_MS` keeps no copy but still
   * lets an earlier one go, without a turn — one call beside the request's turns, made only where a
   * write before it holds the turn this long — since a copy of an earlier record would answer a read
   * KV is behind on in this one's place.
   */
  async #write(
    entryId: string,
    change: RecordOf & { readonly record?: Uint8Array | undefined },
  ): Promise<void> {
    const turns = turnsOfRequest()?.writes;
    try {
      const turn = turns === undefined || (await turns.take(RECORD_COPY_TURN_MS));
      try {
        const key = await this.#keyOf(entryId);
        const cache = await this.#storage.open(this.#naming.copyCache);
        const standing = await standingOf(cache, key);
        const record = turn ? change.record : undefined;
        if (record === undefined) {
          if (standing === undefined || laterThan(change, standing)) {
            await cache.delete(key);
          }
          return;
        }
        const { revision } = change;
        if (standing !== undefined && laterThan(standing, change)) {
          return;
        }
        const headers = {
          'content-type': 'application/octet-stream',
          'cache-control': `max-age=${RECORD_COPY_MAX_AGE_SECONDS}`,
          [SEQ_HEADER]: String(change.seq),
          [RECORD_REVISION_HEADER]: String(revision),
        };
        try {
          await cache.put(key, new Response(record as BodyInit, { headers }));
        } catch (error) {
          // What the key held is no later than this generation, which a read KV is behind would
          // be answered with although the authority holds this one.
          await cache.delete(key);
          throw error;
        }
      } finally {
        if (turn) {
          turns?.give();
        }
      }
    } catch (error) {
      warn(
        change.record === undefined ? 'record copy removal failed' : 'record copy write failed',
        error,
      );
    }
  }

  /**
   * The Cache API's answer for the entry, asked in one of the request's turns, as an artifact's
   * copy is looked up (`COPY_LOOKUPS_AT_ONCE`). None where no turn came in time.
   */
  async #lookUp(entryId: string): Promise<Response | undefined> {
    const turns = turnsOfRequest()?.lookups;
    if (turns !== undefined && !(await turns.take(RECORD_COPY_READ_MS))) {
      return undefined;
    }
    try {
      const key = await this.#keyOf(entryId);
      const cache = await this.#storage.open(this.#naming.copyCache);
      return await cache.match(key);
    } finally {
      turns?.give();
    }
  }

  /**
   * Room in the isolate's budget for a copy `bytes` long: taken at once where there is room, and
   * otherwise waited for no longer than `ms`. The bytes taken, to be given back, or `undefined`
   * where none came in time — and the copy's place in line given up with it.
   */
  async #roomFor(bytes: number, ms: number): Promise<number | undefined> {
    const now = this.#budget.takeAtOnce(bytes);
    if (now !== undefined) {
      return now;
    }
    const given = new AbortController();
    const timer = setTimeout(() => {
      given.abort();
    }, ms);
    try {
      return await this.#budget.take(bytes, given.signal);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The copy's body, read in room of its own once the isolate has it (`#roomFor`): as long as the
   * copy says it is, or, where it says nothing, the largest copy kept. `undefined` where no room
   * came within what is left of the read's time, or for a body longer than its room; the room goes
   * back once the body is read or given up. Rejects where the body stalls or fails.
   */
  async #bodyOf(found: Response, startedAt: number): Promise<Uint8Array | undefined> {
    const length = countOf(found, 'content-length') ?? MAX_RECORD_COPY_BYTES;
    if (length > MAX_RECORD_COPY_BYTES) {
      releaseStream(found.body, 'a record copy longer than any kept');
      return undefined;
    }
    const room = await this.#roomFor(length, leftOf(startedAt));
    if (room === undefined) {
      releaseStream(found.body, 'a record copy with no room in time');
      return undefined;
    }
    try {
      const left = leftOf(startedAt);
      const body = await readBoundedBody(found.body, {
        limit: length,
        stallMs: left,
        budgetMs: left,
      });
      if (body.kind === 'over-limit') {
        releaseStream(body.body, 'a record copy longer than its room');
        return undefined;
      }
      return body.bytes;
    } finally {
      this.#budget.give(room);
    }
  }

  /**
   * Keep the record a commit wrote, of generation `of.seq` at record revision `of.revision`, as the
   * data center's copy of the entry's, unless the copy is of a later record already. One too large
   * to be read back whole is not kept, and lets go of a copy of an earlier generation. Never
   * rejects: the authority has the record already, and a copy not kept is only a render more in
   * another isolate.
   */
  async keep(entryId: string, record: Uint8Array, of: RecordOf): Promise<void> {
    const change =
      record.byteLength > MAX_RECORD_COPY_BYTES
        ? { seq: of.seq, revision: of.revision }
        : { seq: of.seq, revision: of.revision, record };
    await within(this.#write(entryId, change), RECORD_COPY_WRITE_MS);
  }

  /**
   * Let go of the entry's copy where it is of an earlier record than `than`: a commit published one
   * this Function keeps none of, or may have, and a copy of an earlier one would answer a read KV is
   * behind on in its place. A copy of it, or of a later one, stays. Never rejects.
   */
  async drop(entryId: string, than: RecordOf): Promise<void> {
    await within(this.#write(entryId, than), RECORD_COPY_WRITE_MS);
  }

  /**
   * The data center's copy of the entry's record where it holds a later generation than `than`,
   * or `undefined`: none kept, none in time, one no later, or none that reads as one. Never
   * rejects.
   */
  async find(entryId: string, than: number): Promise<Uint8Array | undefined> {
    const startedAt = Date.now();
    const lookup = this.#lookUp(entryId);
    try {
      const found = await within(lookup, RECORD_COPY_READ_MS);
      if (found === undefined) {
        // None, or none in time: one that turns up later is let go of unread.
        void releaseLate(lookup).catch(() => {
          // A lookup that fails once the read has its answer is no longer the read's to report.
        });
        return undefined;
      }
      const seq = seqOf(found);
      if (seq === undefined || seq <= than || leftOf(startedAt) <= 0) {
        releaseStream(found.body, 'a record copy no later than the one read');
        return undefined;
      }
      return await this.#bodyOf(found, startedAt);
    } catch (error) {
      warn('record copy read failed', error);
      return undefined;
    }
  }
}
