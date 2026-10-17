import { sha256HexOfText } from '@stayingupwind/core/artifact';
import { type ScopeRevision } from '@stayingupwind/core/paas';
import { readBoundedBody, releaseStream } from '@stayingupwind/core/util';
import { type TagRevision, tagRevisionSchema } from '@stayingupwind/host/cache';

import { behindResponse, cacheStorage, type FunctionCacheNaming, within } from './artifacts.ts';

/**
 * Where the scope's tags stand, as the Function's data center knows it: the revision of the scope's
 * latest invalidation and when it took effect, kept in the Cache API and asked of the authority
 * again, behind the response, once it is a moment old (`FRESH_MS`) — by whichever isolate of the
 * data center first finds it so, which claims the question for itself (`#claim`): the others that
 * find the copy old or gone before the answer is kept leave the question to it. The runtime asks
 * for it at the start of a request that came without the revision (`CacheHost.scopeRevision`), and
 * an isolate whose view of the tags is behind a recent invalidation brings the view up before the
 * request is judged.
 *
 * It is how an invalidation reaches the other isolates of a deployment where nothing in front of
 * the Function tells them sooner, and it asks nothing of the account it runs on: no purge, and no
 * limit a plan sets. The authority is asked about once a moment for each data center a deployment
 * is served from while it has traffic — the Cache API has no compare-and-set, so isolates that
 * claim the question in the same moment both ask — and never on a request's way to its first byte,
 * so an invalidation is acted on within that moment and a round trip, and one request — the one
 * that found the copy old is answered on the view it had, and the one after it is caught up. A
 * host whose edge says where the scope stands on every request (`SCOPE_REVISION_HEADER`) has no
 * need of it.
 *
 * Kept under a key derived with the scope's token, as the data copies are, and read as what it is:
 * what the Cache API holds there could have been put by anything that opens the copies' cache.
 */

/** How long an isolate answers from what it last found, before it looks at the copy again. */
const HOLD_MS = 250;
/** How old a copy may be before it is asked again: the moment within which an invalidation is seen. */
const FRESH_MS = 2000;
/** How long the Cache API keeps a copy at all: one older than `FRESH_MS` still answers, asked again. */
const KEEP_SECONDS = 60;
/** How long a read waits on the copy: past it, the request goes on as if there were none. */
const READ_MS = 50;
/** How long a write waits for the Cache API, behind the response. */
const WRITE_MS = 1000;
/**
 * How long a question to the authority is taken to be out at the most: one whose request ended
 * under it, where the runtime gives the work no more time, never answers, and another is asked.
 */
const ASK_LIFETIME_MS = 10_000;
/**
 * How long an isolate that asks the authority has the question to itself in its data center
 * (`#claim`): as long as an answer takes, and more. Past it, one not answered is asked again, by
 * whichever isolate next finds the copy old or gone.
 */
const CLAIM_MS = 1000;
/** How long the Cache API keeps a claim at all: past `CLAIM_MS`, in its whole seconds. */
const CLAIM_KEEP_SECONDS = 2;
/** When an isolate claimed the question, in its own clock. */
const CLAIMED_AT_HEADER = 'x-arkor-claimed-at';
/** What a claim this isolate made comes to: the question is its own to ask. */
const MINE = Symbol('the question is this isolate’s');
/** The largest copy read: a few numbers, where anything longer is not one. */
const MAX_COPY_BYTES = 1024;
/** When the copy was kept, in the isolate's own clock: read before the body. */
const KEPT_AT_HEADER = 'x-arkor-kept-at';
/** The revision the copy says the scope stands at, read without its body. */
const REVISION_HEADER = 'x-arkor-revision';

/** The revision a copy says it holds, read without its body; none for none, or none that reads. */
function revisionOf(response: Response | undefined): number | undefined {
  const value = Number(response?.headers.get(REVISION_HEADER));
  return Number.isSafeInteger(value) ? value : undefined;
}

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

/** A copy as a read finds it: where the scope stands, and when the copy was kept. */
interface Found {
  readonly revision: ScopeRevision;
  readonly keptAt: number;
}

/** What this isolate last found, and when it looked. */
interface Held {
  readonly revision: ScopeRevision;
  readonly checkedAt: number;
}

function keptAtOf(response: Response): number | undefined {
  const value = Number(response.headers.get(KEPT_AT_HEADER));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Let go of what a lookup given up on answers with, once it does. */
async function releaseLate(lookup: Promise<Response | undefined>): Promise<void> {
  const late = await lookup;
  releaseStream(late?.body, 'a scope revision that came too late');
}

/** The data center's copy of where one scope's tags stand. */
export class ScopeBeacon {
  /** The beacon of this scope, where the Worker has a Cache API: none under Node.js. */
  static of(
    naming: FunctionCacheNaming,
    scope: { readonly scopeId: string; readonly token: string },
    ask: () => Promise<TagRevision>,
  ): ScopeBeacon | undefined {
    const storage = cacheStorage();
    return storage === undefined ? undefined : new ScopeBeacon(storage, naming, scope, ask);
  }

  readonly #storage: CacheStorage;
  readonly #naming: FunctionCacheNaming;
  readonly #scope: { readonly scopeId: string; readonly token: string };
  readonly #ask: () => Promise<TagRevision>;
  #held: Held | undefined;
  /**
   * The question out to the authority, if one is — or another isolate's, which this one leaves it
   * to: until when it is taken to be out, and which it is.
   */
  #asking: { readonly until: number; readonly mark: symbol } | undefined;

  constructor(
    storage: CacheStorage,
    naming: FunctionCacheNaming,
    scope: { readonly scopeId: string; readonly token: string },
    ask: () => Promise<TagRevision>,
  ) {
    this.#storage = storage;
    this.#naming = naming;
    this.#scope = scope;
    this.#ask = ask;
  }

  async #key(): Promise<string> {
    const secret = await sha256HexOfText(`${this.#scope.token}|scope-revision`);
    return `${this.#naming.copyKeyOrigin}/scope/${encodeURIComponent(this.#scope.scopeId)}/${secret}`;
  }

  async #claimKey(): Promise<string> {
    return `${await this.#key()}/claim`;
  }

  async #lookUp(): Promise<Response | undefined> {
    const cache = await this.#storage.open(this.#naming.copyCache);
    return cache.match(await this.#key());
  }

  /** The data center's copy, read whole within `READ_MS`; none, none in time, or none that reads. */
  async #find(): Promise<Found | undefined> {
    const startedAt = Date.now();
    const lookup = this.#lookUp();
    const found = await within(lookup, READ_MS);
    if (found === undefined) {
      void releaseLate(lookup).catch(() => {
        // A lookup that fails once the read has its answer is no longer the read's to report.
      });
      return undefined;
    }
    const keptAt = keptAtOf(found);
    const left = READ_MS - (Date.now() - startedAt);
    if (keptAt === undefined || left <= 0) {
      releaseStream(found.body, 'a scope revision without its stamp, or too late to read');
      return undefined;
    }
    const body = await readBoundedBody(found.body, {
      limit: MAX_COPY_BYTES,
      stallMs: left,
      budgetMs: left,
    });
    if (body.kind === 'over-limit') {
      releaseStream(body.body, 'a scope revision longer than any kept');
      return undefined;
    }
    const parsed = tagRevisionSchema.safeParse(JSON.parse(new TextDecoder().decode(body.bytes)));
    return parsed.success ? { revision: parsed.data, keptAt } : undefined;
  }

  /**
   * Keep `revision` as the data center's copy, while the question it answers still has its claim
   * (`lapses`), and unless the copy there is of a later one already. Past the claim another isolate
   * may have asked, and kept a later answer that a write begun now could land over: the Cache API
   * has no compare-and-set, so a look before the write narrows that and no more. A write that ends
   * past the claim takes the copy away again, for the next isolate to ask — one question more
   * rather than an older answer kept as new. Isolates that claimed the question in the same moment
   * can still cross.
   */
  async #keep(revision: ScopeRevision, keptAt: number, lapses: number): Promise<void> {
    const cache = await this.#storage.open(this.#naming.copyCache);
    const key = await this.#key();
    const standing = await cache.match(key);
    releaseStream(standing?.body, 'a scope revision looked at for its revision');
    const later = revisionOf(standing);
    if ((later !== undefined && later > revision.revision) || Date.now() >= lapses) {
      return;
    }
    const headers = {
      'cache-control': `max-age=${KEEP_SECONDS}`,
      [KEPT_AT_HEADER]: String(keptAt),
      [REVISION_HEADER]: String(revision.revision),
    };
    await cache.put(key, Response.json(revision, { headers }));
    if (Date.now() >= lapses) {
      await cache.delete(key);
    }
  }

  /**
   * Hold `revision` as where the scope stands, as of `at`, unless this isolate holds a later one:
   * an answer, or a copy, from before it is no news.
   */
  #hold(revision: ScopeRevision, at: number): boolean {
    const held = this.#held;
    if (held !== undefined && held.revision.revision > revision.revision) {
      this.#held = { revision: held.revision, checkedAt: at };
      return false;
    }
    this.#held = { revision, checkedAt: at };
    return true;
  }

  /**
   * Claim the question for this isolate, as of `now`, where no isolate of the data center claimed it
   * within `CLAIM_MS`: `MINE`, or when the claim that stands lapses. The claim is a marker beside the
   * copy, under a key of the scope's own as the copy's is.
   */
  async #claim(now: number): Promise<number | typeof MINE> {
    const cache = await this.#storage.open(this.#naming.copyCache);
    const key = await this.#claimKey();
    const standing = await cache.match(key);
    releaseStream(standing?.body, 'a scope revision claim looked at');
    const claimedAt = Number(standing?.headers.get(CLAIMED_AT_HEADER));
    if (Number.isSafeInteger(claimedAt) && claimedAt > 0 && now - claimedAt < CLAIM_MS) {
      return claimedAt + CLAIM_MS;
    }
    const headers = {
      'cache-control': `max-age=${String(CLAIM_KEEP_SECONDS)}`,
      [CLAIMED_AT_HEADER]: String(now),
    };
    await cache.put(key, new Response('', { headers }));
    return MINE;
  }

  /**
   * `#claim`, or `MINE` where it could not be read or made within `READ_MS`: a claim only spares
   * the authority questions, and one that cannot be made is no reason to ask none. Never rejects.
   */
  async #claimed(now: number): Promise<number | typeof MINE> {
    try {
      return (await within(this.#claim(now), READ_MS)) ?? MINE;
    } catch (error) {
      warn('scope revision claim not made', error);
      return MINE;
    }
  }

  /**
   * Ask the authority where the scope stands, behind the response, and keep the answer as the data
   * center's copy: one question out at a time in an isolate, and another only once that one has
   * answered or been out as long as one can be — and none where another isolate of the data center
   * has claimed the question (`#claim`), until its claim lapses.
   */
  #askBehind(now: number): void {
    if (this.#asking !== undefined && now < this.#asking.until) {
      return;
    }
    // Which question this is: one taken for lost and asked again settles without clearing the
    // place of the one asked since.
    const mark = Symbol('asking');
    this.#asking = { until: now + ASK_LIFETIME_MS, mark };
    const asking = (async (): Promise<void> => {
      const claim = await this.#claimed(now);
      if (claim !== MINE) {
        // Another isolate's question: its answer is the copy this one reads once it is kept.
        if (this.#asking?.mark === mark) {
          this.#asking = { until: claim, mark };
        }
        return;
      }
      try {
        const answer = await this.#ask();
        const revision = { revision: answer.revision, invalidatedAt: answer.invalidatedAt };
        const keptAt = Date.now();
        // An answer behind what this isolate holds — one out long, another asked since — is kept
        // nowhere; one that came past the question's claim is this isolate's alone.
        if (this.#hold(revision, keptAt)) {
          await within(this.#keep(revision, keptAt, now + CLAIM_MS), WRITE_MS);
        }
      } catch (error) {
        warn('scope revision not asked', error);
      } finally {
        if (this.#asking?.mark === mark) {
          this.#asking = undefined;
        }
      }
    })();
    behindResponse(asking);
  }

  /**
   * Where the scope stands, as this isolate last found it within its hold, or as the data center's
   * copy says — which is asked of the authority again behind the response where it is old, or
   * missing. `undefined` where nothing is known yet: the request goes on as it would have. Never
   * rejects, and never waits on the authority.
   */
  async read(): Promise<ScopeRevision | undefined> {
    const now = Date.now();
    if (this.#held !== undefined && now - this.#held.checkedAt < HOLD_MS) {
      return this.#held.revision;
    }
    let found: Found | undefined;
    try {
      found = await this.#find();
    } catch (error) {
      warn('scope revision not read', error);
    }
    if (found !== undefined) {
      this.#hold(found.revision, now);
    }
    if (found === undefined || now - found.keptAt >= FRESH_MS) {
      this.#askBehind(now);
    }
    return this.#held?.revision;
  }
}
