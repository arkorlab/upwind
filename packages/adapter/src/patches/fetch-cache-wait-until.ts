import { occurrencesOf, type Patch, Rewrite } from './types.ts';

/**
 * A cached `fetch`'s write, handed to the request it belongs to.
 *
 * A dynamic render's `fetch` with a `revalidate` is answered from Next.js's data cache, and once
 * the entry is older than that it is fetched again behind the response. The fetch is kept in the
 * work store's `pendingRevalidates`, and so is the cache write that follows it, under
 * `cache-set-<key>`, so that the promise the render hands `waitUntil` covers both. It covers what
 * is there when the render ends — `executeRevalidates` reads the store once — and the write is
 * registered when the fetch's response arrives, which is after that. What `waitUntil` was handed
 * settles once the response's body has been read, while the write is still being sent.
 *
 * On a server the process goes on and the write lands. In a Function a request's work ends once its
 * response has gone and what `waitUntil` was handed has settled, and what is in flight ends with
 * it: the cache gateway was sent the write's headers and never its body. The entry never changed,
 * and every request after it went stale was answered the old value and fetched the origin again
 * behind (`app-dir/app-static`, "should cache correctly for cache: force-cache and revalidate",
 * served by the local deployment in `tools/adapter-tests`). The runtime's Functions-side tests do not
 * show it: there the Function is called from within the test's own request, and a fixture test
 * written for this passed with the patch taken out.
 *
 * The rewrite hands the write to the runtime's hook as it is registered
 * (`Symbol.for('arkor.fetch-cache-write')`, `packages/runtime/src/fetch-cache-writes.ts`),
 * which hands it to the request's `waitUntil`. The fetch it follows has not settled then — it
 * waits for its own copy of the response's body — so the request's work is still under way,
 * whichever copy is read first. Where the runtime installs no hook (`next build` itself, under
 * Node.js), the write is left as Next.js leaves it. Nothing waits for it that did not: `waitUntil`
 * holds a request's work open after its response, never the response.
 *
 * OpenNext does the same for Cloudflare (`patchFetchCacheSetMissingWaitUntil`).
 */

const NAME = 'fetch-cache-wait-until';
/**
 * Every copy of `patch-fetch` a Function can load: the source files, the one each route runtime
 * bundles, and the ones Turbopack compiled into the server output of any `distDir`. The edge
 * graph's, under `server/edge/`, is bundled apart and does not reach this.
 */
const TARGET =
  // eslint-disable-next-line require-unicode-regexp -- a bundler filter: a Go regular expression
  /(?:\/next\/dist\/(?:compiled\/next-server\/[\w-]+\.runtime\.prod|(?:esm\/)?server\/lib\/patch-fetch)|\/server\/(?:chunks|app|pages)\/.+)\.js$/;
/** The key the write is registered under, and the warning its failure logs: both, or not ours. */
const KEY = '`cache-set-${';
const MARKS = [KEY, 'Failed to set fetch cache'];
/**
 * `pendingRevalidates[pendingRevalidateKey] = pendingRevalidatePromise.then(() => cacheSetPromise)
 * .finally(…)`: the write, after any earlier one of the same key, registered in the store. As it
 * reads in the source and after a minifier alike.
 */
const REGISTRATION =
  // eslint-disable-next-line sonarjs/super-linear-regex -- run once per build over a file `next build` wrote, never over anything a request carries
  /(?<slot>[\w$]+\[[\w$]+\])\s*=\s*(?<write>[\w$]+\.then\(\(\)\s*=>\s*[\w$]+\))\.finally\(/gu;
const KEPT =
  '$<slot>=(globalThis[Symbol.for("arkor.fetch-cache-write")]??(w=>w))($<write>).finally(';
const LEFTOVERS = [
  // eslint-disable-next-line sonarjs/super-linear-regex -- as `REGISTRATION`: once per build, over its output
  /[\w$]+\[[\w$]+\]\s*=\s*[\w$]+\.then\(\(\)\s*=>\s*[\w$]+\)\.finally\(/u,
];

export const fetchCacheWaitUntilPatch: Patch = {
  name: NAME,
  target: TARGET,
  // Turbopack puts the module in whichever chunk its graph put it; there is no name to find it by.
  marker: (source) => MARKS.every((mark) => source.includes(mark)),
  nextVersions: ['16.3.5', '16.3.6'],
  apply(source, file) {
    // One registration to each copy of the module, and a chunk may hold more than one: Turbopack
    // puts the one it compiled for each layer that imports it wherever the graph put that layer.
    const copies = occurrencesOf(source, KEY);
    const result = new Rewrite(NAME, file, source)
      .expand(REGISTRATION, KEPT, copies, 'the registration of a fetch cache write')
      .forbid(LEFTOVERS, 'a fetch cache write no request holds');
    return { contents: result.contents, edits: result.edits, notes: [] };
  },
};
