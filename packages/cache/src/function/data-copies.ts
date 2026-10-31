import { sha256HexOfText } from '@stayingupwind/core/artifact';
import { cacheKeyDigestOf, publicationDeadline } from '@stayingupwind/core/cache';
import { readBoundedBody, releaseStream } from '@stayingupwind/core/util';
import {
  answersTheRead,
  dataCopyResponseSchema,
  type DataGetRequest,
  type DataGetResponse,
  type DataSetRequest,
  type DataSetResponse,
} from '@stayingupwind/host/cache';
import { requestClock } from '@stayingupwind/runtime/cache-host';

import { cacheStorage, type FunctionCacheNaming, turnsOfRequest, within } from './artifacts.ts';
import { requestedEntryIdFromDigest } from './entry-identity.ts';
import type { ReadBudget } from './read-budget.ts';

/**
 * The data center's copy of each value this Function wrote to the data cache, read where KV has
 * none of it.
 *
 * A render reads the data cache from KV in its own data center (the read gateway), which keeps an
 * answer there for half a minute (`RECORD_CACHE_TTL_SECONDS`) — that there is none as well. A
 * request that read a key and found none leaves that answer behind it, and a value written for the
 * key meanwhile is read by no other isolate of the data center until the answer goes: each renders
 * the value again, and requests made one after the other read values that disagree. So once the
 * authority has taken a write, the value is kept in the data center's Cache API too, for a little
 * longer than KV keeps an answer, and a read KV answers with none looks there before anything is
 * rendered. The runtime holds the end of a response for its request's writes, this copy among them
 * (`RequestWrites`): a request made once the response was read whole finds the value in any isolate
 * of the data center.
 *
 * A copy is what the writing isolate remembers of its own write (`writeData`), and is judged as a
 * record KV answered with would be — its tags, its age, the invalidation the authority answered the
 * write with. One the authority would have withdrawn by now, past its `expire` or its invalidation's
 * hard expiry, is none. Two writes of one key in one data center can land their copies out of
 * order, so the older one is read until KV has the newer — as KV's own answer in a data center
 * behind the authority's is. The authority's answer to a read, which can come well after it was
 * asked (`keepCurrent`), is not kept over the copy of a later value: each copy says its value's
 * revision (`REVISION_HEADER`).
 *
 * Kept under a key derived with the scope's token, which a write to the authority needs as well:
 * the cache key is the application's to choose, and a key made from it alone would be one anything
 * that opens the copies' cache could plant a value under.
 *
 * A copy is read whole, and every read KV answers with none reads one: an isolate reads no more of
 * them at once than it has room for, in the room it reads records and artifacts in (`ReadBudget`).
 * A copy takes its room once its lookup has answered, before its body is read, and gives it back
 * once the body is read or given up; one that has no room within its read's time is not read, and
 * the read goes on as it would with no copy.
 */

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
/**
 * Past KV's own keeping of an answer (30 s), with room for the copy to be read before it goes; less
 * for a value the authority withdraws sooner (`copyOf`).
 */
const DATA_COPY_MAX_AGE_SECONDS = SECONDS_PER_MINUTE;
const KIB = 1024;
const MIB = KIB * KIB;
/**
 * The largest copy, as it is kept: the value, in the base64 it travels in, and the record around
 * it. A value whose copy runs longer is left to the authority and KV, as one never copied is.
 * The copy is read whole, and what the Cache API holds under the key could have been put there by
 * anything that opens the copies' cache, so a body past this is not read on. It is the room a copy
 * that does not say its length is read in.
 */
const MAX_DATA_COPY_BYTES = MIB;
/**
 * How long a read waits on the copy, its lookup, its room and its body together, past a KV read
 * that found none: a render costs more.
 */
const DATA_COPY_READ_MS = 100;
/**
 * How long a write waits for its turn and for the Cache API to take the copy. The write is one the
 * end of the response waits for, and a render can wait on (`use cache`), so a Cache API that stalls
 * costs either no more than this; the copy is then the next write's to keep.
 */
const DATA_COPY_WRITE_MS = 1000;
/** The header a copy says its value's revision in, read without the copy itself (`keptRevision`). */
const REVISION_HEADER = 'x-data-revision';

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

/**
 * What is left of the time of a read begun at `startedAt` (`DATA_COPY_READ_MS`): one time for the
 * lookup, the wait for room and the body together, so what each took is the next's no longer. The
 * wall clock, not the request's: it moves with the read's I/O.
 */
function leftOf(startedAt: number): number {
  return DATA_COPY_READ_MS - (Date.now() - startedAt);
}

/**
 * How long a copy says it is (`content-length`), which a copy kept here says; `undefined` for one
 * that says nothing that reads.
 */
function statedLength(response: Response): number | undefined {
  const length = response.headers.get('content-length');
  if (length === null || !/^\d+$/u.test(length)) {
    return undefined;
  }
  const bytes = Number(length);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

/** The request's clock, where a test configuration hands it one; the wall clock otherwise. */
function now(): number {
  return requestClock() ?? Date.now();
}

/**
 * When the authority withdraws the value (`retireExpiredData`): once past the `expire` it was
 * written with, or the hard expiry of an invalidation that reached it; `undefined` for neither.
 */
function withdrawalOf(copy: DataGetResponse): number | undefined {
  const { entry, invalidation } = copy;
  const expiry = entry.expire > 0 ? entry.timestamp + entry.expire * MS_PER_SECOND : undefined;
  const publication = publicationDeadline(entry.tags);
  const hard =
    publication === undefined
      ? invalidation?.hardExpireAt
      : Math.min(publication, invalidation?.hardExpireAt ?? publication);
  if (expiry === undefined || hard === undefined) {
    return expiry ?? hard;
  }
  return Math.min(expiry, hard);
}

/** Whether the authority would have withdrawn the value by `at` (`withdrawalOf`). */
function withdrawnBy(copy: DataGetResponse, at: number): boolean {
  const withdrawal = withdrawalOf(copy);
  return withdrawal !== undefined && withdrawal <= at;
}

/** A copy as it is kept: its record, the seconds the data center keeps it for, and its revision. */
interface KeptCopy {
  readonly body: ReturnType<TextEncoder['encode']>;
  readonly maxAge: number;
  readonly revision: number;
}

/**
 * The copy of the value the authority took, as it is kept, or `undefined` where it is not to be
 * kept: too large to be read back whole — told by its base64 before anything is made of it, since a
 * value of up to 25 MiB would be held twice more over to find that out — or one the authority would
 * have withdrawn within the second. Kept no longer than until the authority withdraws it: past that
 * every read would find it only to read it whole and put it aside.
 */
function copyOf(request: DataSetRequest, written: DataSetResponse): KeptCopy | undefined {
  if (request.valueBase64.length > MAX_DATA_COPY_BYTES) {
    return undefined;
  }
  return keptOf({
    entryId: written.entryId,
    generationId: written.generationId,
    dependencyRevision: written.revision,
    entry: request.entry,
    value: { kind: 'inline', base64: request.valueBase64 },
    ...(written.invalidation !== undefined && { invalidation: written.invalidation }),
  });
}

/**
 * `copy` as it is kept, for no longer than until the authority withdraws its value, or `undefined`
 * where it is not to be kept: its record longer than a copy is read back whole, or its value one
 * the authority would have withdrawn within the second.
 */
function keptOf(copy: DataGetResponse): KeptCopy | undefined {
  const withdrawal = withdrawalOf(copy);
  const maxAge =
    withdrawal === undefined
      ? DATA_COPY_MAX_AGE_SECONDS
      : Math.min(DATA_COPY_MAX_AGE_SECONDS, Math.floor((withdrawal - now()) / MS_PER_SECOND));
  if (maxAge < 1) {
    return undefined;
  }
  const body = new TextEncoder().encode(JSON.stringify(copy));
  return body.byteLength > MAX_DATA_COPY_BYTES
    ? undefined
    : { body, maxAge, revision: copy.dependencyRevision };
}

/**
 * The revision of the copy the key holds, as its header says, the copy itself unread: `-1` where
 * the key holds none, and `NaN` for one kept before copies said — neither later than any value.
 */
async function keptRevision(cache: Cache, key: string): Promise<number> {
  const kept = await cache.match(key);
  releaseStream(kept?.body, 'a data copy asked for its revision');
  return Number(kept?.headers.get(REVISION_HEADER) ?? -1);
}

/** Let go of what a lookup given up on answers with, once it does. */
async function releaseLate(lookup: Promise<LocatedCopy | undefined>): Promise<void> {
  const late = await lookup;
  releaseStream(late?.response.body, 'a data copy that came too late');
}

/** The bytes found with the digest already taken for the requested key. */
interface LocatedCopy {
  readonly response: Response;
  readonly digest: string;
}

/** The scope whose copies these are, and the token that opens it. */
interface CopiesScope {
  readonly scopeId: string;
  readonly token: string;
}

/** The data center's Cache API, under the copies' cache and a key of this scope's own. */
export class DataCopies {
  /**
   * The copies of this scope, where the Worker has a Cache API: none under Node.js. Read in
   * `budget`, the isolate's room for what it reads whole.
   */
  static of(
    naming: FunctionCacheNaming,
    scope: CopiesScope,
    budget: ReadBudget,
  ): DataCopies | undefined {
    const storage = cacheStorage();
    return storage === undefined ? undefined : new DataCopies(storage, naming, scope, budget);
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

  async #keyOf(
    request: DataGetRequest,
  ): Promise<{ readonly key: string; readonly digest: string }> {
    const digest = await cacheKeyDigestOf({
      kind: request.kind,
      key: request.key,
      ...(request.handler !== undefined && { handler: request.handler }),
    });
    const secret = await sha256HexOfText(`${this.#token}|${digest}`);
    return {
      key: `${this.#naming.copyKeyOrigin}/data/${encodeURIComponent(this.#scopeId)}/${secret}`,
      digest,
    };
  }

  /**
   * Put the copy — or, given none, let go of the one the key had — in one of the request's turns,
   * as an artifact's copy is written (`COPY_WRITES_AT_ONCE`): given back once the Cache API has
   * answered, however long the write waited for it. A put the Cache API refuses lets go of the
   * key's copy as well, which is an earlier value's. Given `stands`, the copy the key holds is left
   * as it is where the revision of its value (`keptRevision`) stands against the value at hand: a
   * later value's, say.
   */
  async #write(
    descriptor: DataGetRequest,
    copy: KeptCopy | undefined,
    stands?: (kept: number) => boolean,
  ): Promise<true | undefined> {
    const turns = turnsOfRequest()?.writes;
    try {
      if (turns !== undefined && !(await turns.take(DATA_COPY_WRITE_MS))) {
        return undefined;
      }
      try {
        const { key } = await this.#keyOf(descriptor);
        const cache = await this.#storage.open(this.#naming.copyCache);
        if (stands?.(await keptRevision(cache, key)) === true) {
          return true;
        }
        if (copy === undefined) {
          await cache.delete(key);
          return true;
        }
        const headers = {
          'content-type': 'application/json',
          'cache-control': `max-age=${copy.maxAge}`,
          [REVISION_HEADER]: String(copy.revision),
        };
        try {
          await cache.put(key, new Response(copy.body, { headers }));
        } catch (error) {
          await cache.delete(key);
          throw error;
        }
        return true;
      } finally {
        turns?.give();
      }
    } catch (error) {
      warn(copy === undefined ? 'data copy removal failed' : 'data copy write failed', error);
      return undefined;
    }
  }

  /**
   * The Cache API's answer for the key, asked in one of the request's turns, as an artifact's copy
   * is looked up (`COPY_LOOKUPS_AT_ONCE`): given back once it has answered. None where no turn came
   * in time.
   */
  async #lookUp(request: DataGetRequest): Promise<LocatedCopy | undefined> {
    const turns = turnsOfRequest()?.lookups;
    if (turns !== undefined && !(await turns.take(DATA_COPY_READ_MS))) {
      return undefined;
    }
    try {
      const { key, digest } = await this.#keyOf(request);
      const cache = await this.#storage.open(this.#naming.copyCache);
      const response = await cache.match(key);
      return response === undefined ? undefined : { response, digest };
    } finally {
      turns?.give();
    }
  }

  /**
   * The copy's body, read in room of its own once the isolate has it (`takeWithin`): as long as the
   * copy says it is, or, where it says nothing, the largest copy kept. `undefined` where no room
   * came within what is left of the read's time, or for a body longer than its room; the room goes
   * back once the body is read or given up. Rejects where the body stalls or fails.
   */
  async #bodyOf(found: Response, startedAt: number): Promise<Uint8Array | undefined> {
    const length = statedLength(found) ?? MAX_DATA_COPY_BYTES;
    if (length > MAX_DATA_COPY_BYTES) {
      releaseStream(found.body, 'a data copy longer than any kept');
      return undefined;
    }
    const giveBack = await this.#budget.takeWithin(length, leftOf(startedAt));
    if (giveBack === undefined) {
      releaseStream(found.body, 'a data copy with no room in time');
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
        releaseStream(body.body, 'a data copy longer than its room');
        return undefined;
      }
      return body.bytes;
    } finally {
      giveBack();
    }
  }

  /**
   * Keep the value the authority took as the data center's copy (`copyOf`). One that is not to be
   * kept — too large, or withdrawn already — lets go of the copy the key had instead, and so does a
   * put the Cache API refuses: that copy is an earlier value's, which a read KV answers with none
   * would be answered with though the authority holds a later one. One whose turn does not come in
   * time leaves it, as a copy not kept would; KV's answer of none it covers lasts no longer than
   * its `cacheTtl`. Never rejects — the authority has the value already, and a copy not kept is
   * only a render more in another isolate.
   *
   * A write the authority kept a later write of its writer over (`superseded`) keeps no copy: the
   * copy is that later write's to keep, and is left as it is, as is one of a value later still. The
   * answer names that write by its revision, and the copy of an earlier value goes: the later
   * write's own copy may never have been kept — its answer lost, or its turn not come in time — and
   * a read KV answers with none would be answered with the earlier value. The check and the removal
   * are two calls, as `keepCurrent`'s check and put are: the later write's copy put between them
   * goes as well, which costs a render more, and never answers with an earlier value.
   */
  async keep(request: DataSetRequest, written: DataSetResponse): Promise<void> {
    const descriptor: DataGetRequest = {
      key: request.key,
      kind: request.entry.kind,
      ...(request.entry.handler !== undefined && { handler: request.entry.handler }),
    };
    const write =
      written.superseded === true
        ? this.#write(descriptor, undefined, (kept) => kept >= written.revision)
        : this.#write(descriptor, copyOf(request, written));
    await within(write, DATA_COPY_WRITE_MS);
  }

  /**
   * Keep the value the authority holds now, which a read found later than KV's answer
   * (`currentData`), as the data center's copy: the isolates after the one that asked find it here
   * rather than each asking the authority again. As the copy of a write is (`keep`): one not to be
   * kept lets go of the copy the key had, an earlier value's, and nothing rejects. Not over the copy
   * of a later value, though: the answer can come well after it was asked — past the runtime's
   * wait, or behind the request's other writes — and a write of the key here can have kept one
   * meanwhile.
   *
   * The check and the put are two calls to a Cache API that has no compare-and-set: a later copy
   * put between them, by another request or another isolate of the data center, is taken back all
   * the same, as one write's copy landing after a later write's is. Serializing them within this
   * isolate would leave that race across the others, and hold the copies of other requests' writes,
   * which the ends of their responses wait for, behind this one. What it leaves is narrow — the
   * check's round trip, not the authority's — and mends itself: a copy no better than stale is
   * asked past by the next read that finds it (`laterIfAny`), and the authority's answer to that
   * replaces it.
   */
  async keepCurrent(request: DataGetRequest, current: DataGetResponse): Promise<void> {
    await within(
      this.#write(request, keptOf(current), (kept) => kept > current.dependencyRevision),
      DATA_COPY_WRITE_MS,
    );
  }

  /**
   * The data center's copy of a value KV has none of, or `undefined`: none kept, none in time, or
   * none that reads as one. Never rejects.
   */
  async find(request: DataGetRequest): Promise<DataGetResponse | undefined> {
    const startedAt = Date.now();
    const lookup = this.#lookUp(request);
    try {
      const found = await within(lookup, DATA_COPY_READ_MS);
      if (found === undefined) {
        // None, or none in time: one that turns up later is let go of unread.
        void releaseLate(lookup).catch(() => {
          // A lookup that fails once the read has its answer is no longer the read's to report.
        });
        return undefined;
      }
      if (leftOf(startedAt) <= 0) {
        releaseStream(found.response.body, 'a data copy found too late to read');
        return undefined;
      }
      const bytes = await this.#bodyOf(found.response, startedAt);
      if (bytes === undefined) {
        return undefined;
      }
      const parsed = dataCopyResponseSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      return parsed.success &&
        !withdrawnBy(parsed.data, now()) &&
        answersTheRead(request, parsed.data) &&
        parsed.data.entryId ===
          requestedEntryIdFromDigest(this.#scopeId, request.kind, found.digest)
        ? parsed.data
        : undefined;
    } catch (error) {
      warn('data copy read failed', error);
      return undefined;
    }
  }
}
