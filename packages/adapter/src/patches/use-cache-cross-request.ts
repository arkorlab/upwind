import { occurrencesOf, type Patch, Rewrite } from './types.ts';

/**
 * A `"use cache"` invocation, joined only by invocations of the request it belongs to.
 *
 * From 16.3 Next.js deduplicates a cached function's invocations (`use-cache-wrapper.ts`). Within a
 * request, an invocation of a key that another of the same request has under way joins it through
 * the work store's `pendingCacheInvocations`. Across requests it does the same through a map at the
 * module's top, `crossRequestPendingCacheInvocations` — "Module-scope map for cross-request
 * deduplication". The first invocation of a key is the leader: it registers itself in both maps,
 * asks the cache handler, and on a miss fills the entry. One that finds the key registered by
 * another request waits for the leader's result and is handed its `SharedCacheEntry`, whose
 * `fork()` tees the entry's stream — one branch for the joiner, the other kept for whoever joins
 * next. Only a private cache outside the development server, and from 16.3.8 a draft-mode request,
 * is kept out of it (`skipCrossRequestDedupe`).
 *
 * On a server, requests share a process and a stream is anyone's to tee. A Function serves many
 * requests in one isolate at once, and an I/O object made in one request's context cannot be used
 * from another's. So a request that rendered a public cached function while another request was
 * still reading the same key was handed the other's stream, and teeing it threw at `fork`: "Cannot
 * perform I/O on behalf of a different request … (I/O type: ReadableStreamSource)". The failed tee
 * leaves the stream locked, and every fork after it — a later joiner's, the leader's own next
 * joiner's — threw "This ReadableStream is currently locked to a reader". A page rendered that way
 * failed with a render error's digest, and a route handler was answered 500.
 *
 * What shows it is a hit, and two requests close together. Tried in workerd at the Function's
 * compatibility date: a stream made with `new ReadableStream` in one request, or a branch of one,
 * tees in another without complaint, while a body — what `Blob.prototype.stream` answers, which is
 * how the runtime's cache handler answers a read, and what any handler reading storage hands back —
 * refuses as above, and a second tee of it reports the lock. An entry the leader read from the
 * cache handler is such a body. The second request has to look for the key between the leader
 * registering it and the leader's read coming back, which is as long as the read takes.
 * `fixtures/next-use-cache-concurrency` is that, run in workerd by `tools/next-matrix`: without
 * this patch the second request is answered 500, with it both are answered from the entry.
 *
 * The map can also outlive the request that registered in it. workerd stops a request's work at
 * its next `await` once the request is cancelled — its client gone — and a leader stopped there
 * neither settles what it registered nor takes it out, so every later invocation of the key in the
 * isolate would wait on it for as long as its own request was let run. The runtime keeps its own
 * reads of the host apart across requests for the same reason (`readData`,
 * `packages/runtime/src/cache/data.ts`).
 *
 * Both places that read `skipCrossRequestDedupe` read `true` instead: an invocation neither looks
 * for another request's nor registers its own, and the map is never touched. What a request shares
 * with itself is unchanged — its joiners are found in its own work store and fork a stream made in
 * its own context. What it costs is the sharing: two requests in one isolate that want the same key
 * at the same moment each ask the cache handler for it, and on a miss each fill it — as every
 * release before 16.3 did, as a private cache or a draft-mode request still does, and as two
 * isolates do in any case, since each has a map of its own.
 *
 * Each read is found by the message Next.js logs beside it (`NEXT_PRIVATE_DEBUG_CACHE`), which is a
 * string and so survives a minifier where the names do not: `joining pending cross-request
 * invocation` is logged a few statements into the branch the lookup guards, and `registering as
 * cross-request invocation leader` is the first thing the registration does. The flag is not
 * something to find by its name: a build defines `process.env.__NEXT_DEV_SERVER` as an empty string,
 * the minifier folds what that leaves, and the chunk declares the rest under a name of its own
 * (`let f=X&&!0||_.isDraftMode`). So what is rewritten is each read, whatever it is called there.
 *
 * What is left alone is the other map at the module's top, `backgroundRevalidations` (16.4: "Prevent
 * duplicate background revalidations for the same key until generation and cache writes finish").
 * It holds the promise of a revalidation one request started behind a stale read, and another
 * request only asks whether there is one — `get` compared with `undefined` before its read, and
 * `has` after it — to decide not to start a second. Nothing awaits that promise but the request
 * that made it, which keeps it in its own `pendingRevalidateWrites`; no stream is reached through
 * it; and the `finally` that takes it out of the map is that request's own continuation. No request
 * is handed another's I/O through it. One whose request is stopped before it settles stays in the
 * map, and no other revalidation of that key starts in the isolate — the stale entry is served
 * until a read of it misses and fills it — but nothing waits on it. The third,
 * `knownRootParamsByFunctionId`, holds the names of root params.
 *
 * 16.2 deduplicates nothing, and its wrapper has neither map: there the module is found and left as
 * it is.
 */

const NAME = 'use-cache-cross-request';
/**
 * Next.js's own files, and the server output of any `distDir` Turbopack compiled the module into.
 * The edge graph's, under `server/edge/`, is bundled apart, and a cached function runs on the
 * Node.js runtime alone.
 */
const TARGET =
  // eslint-disable-next-line require-unicode-regexp -- a bundler filter: a Go regular expression
  /(?:\/next\/dist\/(?:esm\/)?server\/use-cache\/use-cache-wrapper|\/server\/(?:chunks|app|pages)\/.+)\.js$/;
/**
 * What `cache()` throws where there is no work store: Next.js's own words, one to each copy of the
 * wrapper, in every release of the range. Read without its quotes, which a minifier may change.
 */
const WRAPPER = 'cannot be used outside of App Router. Expected a WorkStore.';
/** What the wrapper renders a fill under: a method of the work store, which no minifier renames. */
const FILL = 'runInCleanSnapshot';
const JOINING = 'joining pending cross-request invocation';
const REGISTERING = 'registering as cross-request invocation leader';
/**
 * What says a copy deduplicates at all. The two messages, and the work store's map, which arrived
 * with the cross-request one in 16.3 and is a property, so a minifier keeps it. A copy that has any
 * of them has to have both reads, and one that does not is a shape this has not read: the build
 * fails rather than ship the join.
 */
const DEDUPES = [JOINING, REGISTERING, 'pendingCacheInvocations'];
/** How one kind of file writes the two places the flag is read. */
interface Shape {
  /** The lookup, followed a few statements on by the message the branch it guards logs. */
  readonly lookup: RegExp;
  /**
   * The registration's guard, directly before the message the registration logs first. Nothing
   * ends a statement or a block between the two, so the guard is the one around the message.
   */
  readonly guard: RegExp;
}

/**
 * The two kinds of file the wrapper reaches a Function in. Next.js's own, which its build writes
 * with the names the source gave them — `skipCrossRequestDedupe ? undefined :
 * crossRequestPendingCacheInvocations.get(…)` and `if (!skipCrossRequestDedupe) {` — as does a chunk
 * Turbopack wrote with `experimental.serverMinification` off; and a chunk a minifier has been
 * through: `f?void 0:J.get(aB)` and `f||(`. Each match is the flag and nothing else, and `true`
 * takes its place. Which kind a file is, is read off the file, and every copy in one file is of the
 * same kind.
 */
const SHAPES: readonly Shape[] = [
  {
    lookup:
      /(?<![\w$.])[\w$]+(?= \? undefined : [\w$]+\.get\([\w$]+\);[\s\S]{0,600}?joining pending cross-request invocation)/gu,
    guard:
      /(?<=if \(!)[\w$]+(?=\) \{[^;{}]{0,200}?registering as cross-request invocation leader)/gu,
  },
  {
    lookup:
      /(?<![\w$.])[\w$]+(?=\?void 0:[\w$]+\.get\([\w$]+\);[\s\S]{0,600}?joining pending cross-request invocation)/gu,
    guard:
      /(?<![\w$.!])[\w$]+(?=\|\|\([^;{}]{0,200}?registering as cross-request invocation leader)/gu,
  },
];
const LOOKUP = "the lookup of another request's invocation";
/**
 * The flag, read anywhere but where it is declared: a third read in Next.js's own files would be
 * one this rewrite left as it was. A chunk has the flag under another name, and its two reads are
 * held to the copies by the counts instead.
 */
const LEFTOVERS = [/(?<![\w$.])skipCrossRequestDedupe(?!\s*=(?!=))/u];

export const useCacheCrossRequestPatch: Patch = {
  name: NAME,
  target: TARGET,
  // Turbopack puts the module in whichever chunk its graph put it; there is no name to find it by.
  marker: (source) => source.includes(WRAPPER) && source.includes(FILL),
  // The wrapper's own file, the ESM copy beside it, and the chunk a build compiled it into. Not the
  // compiled runtimes: none of them carries the wrapper.
  reaches: ['module', 'esm-module', 'build-output'],
  apply(source, file) {
    const copies = occurrencesOf(source, WRAPPER);
    if (DEDUPES.every((mark) => !source.includes(mark))) {
      return {
        contents: source,
        edits: 0,
        notes: [`${String(copies)} copy/copies of the wrapper, deduplicating nothing`],
      };
    }
    const rewrite = new Rewrite(NAME, file, source);
    const shape = SHAPES.find(
      (candidate) =>
        occurrencesOf(source, candidate.lookup) > 0 || occurrencesOf(source, candidate.guard) > 0,
    );
    if (shape === undefined) {
      throw rewrite.fail(`expected ${LOOKUP} ${String(copies)} time(s), found 0`);
    }
    // One lookup and one registration to each copy of the wrapper, and a chunk may hold more than
    // one: Turbopack puts the one it compiled for each layer that imports it wherever the graph
    // put that layer.
    const result = rewrite
      .replace(shape.lookup, 'true', copies, LOOKUP)
      .replace(shape.guard, 'true', copies, 'the registration of an invocation for other requests')
      .forbid(LEFTOVERS, 'a read of skipCrossRequestDedupe');
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [`${String(copies)} copy/copies of the wrapper, joined within a request alone`],
    };
  },
};
