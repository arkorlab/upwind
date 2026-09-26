import type { AppModule, EdgeModule, NodeHandler, WebHandler } from './app-module.ts';
import { admitting } from './cache/fetch-patch.ts';
import { asMiddleware } from './middleware-scope.ts';

/**
 * The entrypoints a deployment carries, and how each is invoked.
 *
 * The two runtimes Next.js builds for take different things: a Node.js entrypoint the request and
 * response of a `node:http` server, an edge one a Web `Request`. Which one a route is on is what
 * the build said, and no route is on both — so the two tables are looked up in turn, and what
 * comes back says how to call what it found.
 *
 * Each table is a Next.js module graph of its own, and a graph has to be let in to the global
 * `fetch` for the length of an invocation before anything it renders can cache one
 * (`cache/fetch-patch.ts`). Every handler a request reaches comes from here, so every handler
 * handed out is wrapped in its graph's turn.
 *
 * Looking one up is asynchronous, because what a thunk hands back may be a promise. `require` of
 * an entrypoint whose source has a top-level await — a `middleware.ts` that awaits a
 * configuration read, a page that instantiates WebAssembly — returns a promise of the module
 * rather than the module, and the `.handler` read off that is `undefined`: the request reaches
 * `handler is not a function` and answers 500, every time, for as long as the entrypoint is
 * deployed. The bundle's own module registry evaluates each entrypoint once, so from the second
 * request on this awaits a value that is already there.
 */

/** Where a deployment's entrypoints live: the Worker's two generated modules. */
export interface EntryTables {
  readonly app: AppModule;
  readonly edge: EdgeModule;
}

export type Entry =
  | { readonly kind: 'node'; readonly handler: NodeHandler }
  | { readonly kind: 'edge'; readonly handler: WebHandler };

/** Whether the deployment has an entrypoint for `id`, without loading it. */
export function hasEntry(tables: EntryTables, id: string): boolean {
  return tables.edge.entries[id] !== undefined || tables.app.entries[id] !== undefined;
}

/** The entrypoint for `id`, loaded: its module is evaluated here, on the first request for it. */
export async function entryFor(tables: EntryTables, id: string): Promise<Entry | undefined> {
  const edge = tables.edge.entries[id];
  if (edge !== undefined) {
    return { kind: 'edge', handler: admitting('edge', (await edge()).handler) };
  }
  const handler = await nodeHandlerOf(tables, id);
  return handler === undefined ? undefined : { kind: 'node', handler };
}

/**
 * The Node.js handler for `id`, which alone can resume a shell or render an entry for the cache;
 * `undefined` for a route the deployment does not have, and for one on the edge runtime — whose
 * module is then left unevaluated.
 */
export async function nodeHandlerOf(
  tables: EntryTables,
  id: string,
): Promise<NodeHandler | undefined> {
  if (tables.edge.entries[id] !== undefined) {
    return undefined;
  }
  const load = tables.app.entries[id];
  if (load === undefined) {
    return undefined;
  }
  return admitting('app', (await load()).handler as NodeHandler);
}

/**
 * The middleware, whichever runtime it was built for: `proxy.ts` and the deprecated
 * `middleware.ts` come from one Next.js template and export the same Web handler.
 */
export async function middlewareHandler(
  tables: EntryTables,
  id: string,
): Promise<WebHandler | undefined> {
  const entry = await entryFor(tables, id);
  return entry === undefined ? undefined : asMiddleware(entry.handler as WebHandler);
}
