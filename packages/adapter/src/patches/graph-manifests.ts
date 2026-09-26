import { type Patch, Rewrite } from './types.ts';

/**
 * One Function holds two copies of Next.js: the module graph built for the Node.js runtime, which
 * this bundle is, and the one built for the edge runtime, which `edge.ts` bundles without any
 * patch. Next.js keeps the client reference manifests of the routes it has loaded on a global,
 * `Symbol.for('next.server.manifests')` (`server/app-render/manifests-singleton.ts`), and what it
 * keeps there finds the route being rendered through its own graph's `workAsyncStorage`, while
 * `setManifestsSingleton` registers a route into whatever it finds under the key.
 *
 * Sharing the key, the two graphs shared that object. Whichever registered a route first owned
 * it, and every page of the other graph found no store and threw `Cannot access "entryCSSFiles"
 * without a work store`: a 500 for every page of that runtime until the isolate went, with which
 * runtime depending on which page the isolate happened to render first. The server actions
 * manifest kept beside it was whichever graph registered last.
 *
 * The Node.js graph is given a key of its own. Every file of it that names the key is rewritten
 * the same way — the compiled runtimes, and the chunks Turbopack copied the module into — so the
 * graph still shares one object among its own routes, and the edge graph keeps Next.js's. Nothing
 * of this platform reads either key.
 */

const NAME = 'graph-manifests';
// Next.js's own files, and the server output of any `distDir`: the edge graph's is under
// `server/edge/`, which this does not reach, and it is bundled apart in any case.
const TARGET =
  // eslint-disable-next-line require-unicode-regexp -- a bundler filter: a Go regular expression
  /(?:\/next\/dist\/(?:compiled\/next-server\/[\w-]+\.runtime\.prod|(?:esm\/)?server\/app-render\/manifests-singleton)|\/server\/(?:chunks|app|pages)\/.+)\.js$/;
const SHARED_KEY = /Symbol\.for\((["'])next\.server\.manifests\1\)/gu;
const NODE_KEY = 'Symbol.for("arkor.next.server.manifests.node")';
const LEFTOVERS = [/Symbol\.for\((["'])next\.server\.manifests\1\)/u];

export const graphManifestsPatch: Patch = {
  name: NAME,
  target: TARGET,
  // The chunks Turbopack copied the module into have no name to find them by.
  marker: (source) => LEFTOVERS.some((pattern) => pattern.test(source)),
  apply(source, file) {
    const result = new Rewrite(NAME, file, source)
      .replace(SHARED_KEY, NODE_KEY, 1, 'the key of the manifests singleton')
      .forbid(LEFTOVERS, 'the key the edge graph keeps');
    return { contents: result.contents, edits: result.edits, notes: [] };
  },
};
