import { parseAst } from 'rolldown/parseAst';

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
 *
 * Next.js's own files hold the module once each, and that is held to: a second would be a change
 * this has not read. A chunk can hold more than one copy — a route handler's has held the module
 * and the ESM one beside it, which Turbopack merged into the route's own module — and each is the
 * Node.js graph's, so every one is rewritten. What a chunk is held to is the calls of
 * `Symbol.for` with the key it makes (`keyCalls`), not the text: a string that only reads like
 * one leaves the two counts apart, and the build fails as it did before rather than change it.
 */

const NAME = 'graph-manifests';
// Next.js's own files, and the server output of any `distDir`: the edge graph's is under
// `server/edge/`, which this does not reach, and it is bundled apart in any case.
const TARGET =
  // eslint-disable-next-line require-unicode-regexp -- a bundler filter: a Go regular expression
  /(?:\/next\/dist\/(?:compiled\/next-server\/[\w-]+\.runtime\.prod|(?:esm\/)?server\/app-render\/manifests-singleton)|\/server\/(?:chunks|app|pages)\/.+)\.js$/;
/** What `next build` wrote, of what `TARGET` reaches. */
const BUILD_OUTPUT = /\/server\/(?:chunks|app|pages)\/.+\.js$/u;
const SHARED_KEY = /Symbol\.for\((["'])next\.server\.manifests\1\)/gu;
const NODE_KEY = 'Symbol.for("arkor.next.server.manifests.node")';
const LEFTOVERS = [/Symbol\.for\((["'])next\.server\.manifests\1\)/u];
const KEY = 'next.server.manifests';

/** A node of the tree `parseAst` reads, as far as this looks at one. */
interface Node {
  readonly type: string;
  readonly [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
  );
}

/** `Symbol.for("next.server.manifests")`, as code. */
function isKeyCall(node: Node): boolean {
  const callee = node['callee'];
  const args = node['arguments'];
  if (node.type !== 'CallExpression' || !isNode(callee) || !Array.isArray(args)) {
    return false;
  }
  const object = callee['object'];
  const property = callee['property'];
  const [argument] = args as unknown[];
  return (
    callee.type === 'MemberExpression' &&
    callee['computed'] === false &&
    isNode(object) &&
    object.type === 'Identifier' &&
    object['name'] === 'Symbol' &&
    isNode(property) &&
    property['name'] === 'for' &&
    args.length === 1 &&
    isNode(argument) &&
    argument.type === 'Literal' &&
    argument['value'] === KEY
  );
}

/** How many calls of `Symbol.for` with the key a module makes: its copies of the singleton. */
function keyCalls(source: string): number {
  let calls = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const element of value) {
        walk(element);
      }
      return;
    }
    if (!isNode(value)) {
      return;
    }
    if (isKeyCall(value)) {
      calls += 1;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'type' && typeof child === 'object') {
        walk(child);
      }
    }
  };
  walk(parseAst(source));
  return calls;
}

export const graphManifestsPatch: Patch = {
  name: NAME,
  target: TARGET,
  // The chunks Turbopack copied the module into have no name to find them by.
  marker: (source) => LEFTOVERS.some((pattern) => pattern.test(source)),
  // The singleton's own file and the ESM copy beside it, the compiled runtimes, and the chunks
  // Turbopack copied the module into — which only a build has.
  reaches: ['module', 'esm-module', 'server-runtime', 'build-output'],
  apply(source, file) {
    // A chunk is only read where its text names the key (`marker`); none of its calls naming it is a
    // string that reads like it, which the count refuses, as it refuses one beside a real copy.
    const copies = BUILD_OUTPUT.test(file) ? keyCalls(source) : 1;
    const result = new Rewrite(NAME, file, source)
      .replace(SHARED_KEY, NODE_KEY, copies, 'the key of the manifests singleton')
      .forbid(LEFTOVERS, 'the key the edge graph keeps');
    return { contents: result.contents, edits: result.edits, notes: [] };
  },
};
