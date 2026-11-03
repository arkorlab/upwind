import type { Prerender } from '@stayingupwind/core/bundle';
import { rendersFormActionsWithResumeData } from '@stayingupwind/core/next';
import { NEXT_ACTION_HEADER } from '@stayingupwind/core/request';

import { nowMs } from './cache/clock.ts';
import { currentGeneration } from './cache/current.ts';
import { postponedOf } from './documents.ts';
import { isDraftRequest } from './draft.ts';
import { type Entry, entryFor, hasEntry } from './entries.ts';
import { failureAnswer } from './error-pages.ts';
import { descriptorFor } from './generations.ts';
import { possibleServerAction } from './methods.ts';
import { invokeNodeHandler } from './node-bridge.ts';
import type { Resolved } from './outputs.ts';
import { baseRequestMeta, invokeEntry, type RoutedInput } from './serve.ts';
import {
  completedShell,
  entrypointKindOf,
  findShell,
  queryCompletedShell,
  type Store,
} from './store.ts';

/**
 * A request that carries a body to a route — a server action, a form's post, an upload — which
 * the route's handler answers, and what that handler renders by.
 */

/**
 * The entrypoint that renders a resolved route, and the route it renders under.
 *
 * A prerender the router resolved by its own name — a member of a route the build closed — is a
 * pathname with no module of its own: what renders it is the route the prerender names, and that
 * route is what the shell of the member is filed under too (`store.shellsByRoute`), so it travels
 * with the entrypoint. Reading the page from storage is one thing, and a request that has to be
 * run (a write, a payload) is another; both end up here.
 */
export async function renderedBy(
  input: RoutedInput,
  store: Store,
  resolved: Resolved,
  lookup: typeof entryFor = entryFor,
): Promise<{ readonly entry: Entry; readonly resolved: Resolved } | undefined> {
  const own = await lookup(input, resolved.route);
  if (own !== undefined) {
    return { entry: own, resolved };
  }
  const route = prerenderedRoute(store, resolved);
  if (route === undefined) {
    return undefined;
  }
  const entry = await lookup(input, route);
  return entry === undefined ? undefined : { entry, resolved: { ...resolved, route } };
}

/**
 * The route a resolved member renders under where its own route has no entrypoint (`renderedBy`):
 * the member's own prerender's, where the build made one; else that of the class the router
 * resolved the member to by its name (`resolvedByName`), whose route is the member's.
 */
function prerenderedRoute(store: Store, resolved: Resolved): string | undefined {
  return (
    store.prerendersByPathname.get(resolved.pathname) ??
    store.prerendersByPathname.get(resolved.route)
  )?.route;
}

/**
 * The route `renderedBy` comes to, read off the tables without evaluating a module: the resolved
 * route where an entrypoint of either runtime has it — `entryFor` finds one there, or fails — and
 * the one its prerender names otherwise; `undefined` where there is neither.
 */
function routeRenderedBy(input: RoutedInput, store: Store, resolved: Resolved): string | undefined {
  const { route } = resolved;
  return hasEntry(input, route) ? route : prerenderedRoute(store, resolved);
}

/** A generation a page was answered from, and its postponed state: none where it rendered whole. */
interface AnsweredFrom {
  readonly postponed: Uint8Array | undefined;
}

/**
 * The generation a page was answered from, for an action posted to it: the member's own where the
 * edge had one made for it (`concreteUpgrade`, `generations.ts`), else the class shell's the
 * member was answered from, for a member of a route whose shell has a body. The two are read at
 * once, so a member costs the action no more than one read's wait. A member of a route that
 * blocks was answered from the entry it is kept under: the shell it completes to, where the build
 * keys the route's entries by some of its parameters (`completedShell`), else its own. None
 * without a cache.
 */
async function answeredFrom(
  input: RoutedInput,
  store: Store,
  shell: Prerender,
  pathname: string,
): Promise<AnsweredFrom | undefined> {
  const runtime = input.cache;
  if (runtime === undefined) {
    return undefined;
  }
  const now = nowMs();
  const generationOf = async (entryPathname: string): Promise<AnsweredFrom | undefined> => {
    const descriptor = descriptorFor(store, shell.route, entryPathname);
    const lookup = await currentGeneration(runtime, descriptor, now, input.waitUntil);
    return lookup.kind === 'generation' ? { postponed: lookup.current.pack.postponed } : undefined;
  };
  if (shell.body === undefined) {
    return generationOf(completedShell(shell, pathname));
  }
  const bodyClassKey = queryCompletedShell(shell, pathname) ?? shell.pathname;
  if (bodyClassKey === pathname) {
    return generationOf(pathname);
  }
  const [own, ofClass] = await Promise.all([generationOf(pathname), generationOf(bodyClassKey)]);
  return own ?? ofClass;
}

/** Whether a post is an action whose re-render the page's postponed state is handed to. */
function isActionHandedState(request: Request, store: Store): boolean {
  if (request.headers.has(NEXT_ACTION_HEADER)) {
    return true;
  }
  return (
    possibleServerAction(request) && rendersFormActionsWithResumeData(store.manifest.nextVersion)
  );
}

/**
 * The postponed state a server action's re-render is handed, for an App Router page with one: its
 * current generation's, else the build's shell's. Next.js re-renders the page after the action
 * with the resume data cache that state carries, so what the page's render cached — a `use cache`
 * result, a cached `fetch` — is what the page was answered with (the page template: "Stash
 * postponed state for server actions when in minimal mode"). Rendered without it, the re-render
 * computed them afresh, and a value cached for the page changed under the action
 * (`resume-data-cache`, "should use RDC for server action re-renders").
 *
 * An action a form posted without JavaScript names none in its headers, and is handed the state
 * only where the build's Next.js renders such a post whole with it
 * (`rendersFormActionsWithResumeData`); an earlier one answered it with what follows the shell.
 *
 * None where the current generation rendered whole, and so has none: the page was answered from
 * that generation, and the build's state would hand the re-render what the regeneration replaced.
 * None as well for an action posted in draft mode, whose page was rendered as it is now rather
 * than from anything the build or a regeneration kept (`draft.ts`), and whose re-render is too.
 */
async function actionPostponedFor(
  input: RoutedInput,
  store: Store,
  resolved: Resolved,
): Promise<string | undefined> {
  if (
    !isActionHandedState(input.request, store) ||
    entrypointKindOf(store, resolved.route) !== 'app-page' ||
    isDraftRequest(store, input.request)
  ) {
    return undefined;
  }
  const shell = findShell(store, resolved.route, resolved.pathname);
  if (shell === undefined) {
    return undefined;
  }
  const generation = await answeredFrom(input, store, shell, resolved.pathname);
  if (generation === undefined) {
    return postponedOf(store, shell);
  }
  return generation.postponed === undefined
    ? undefined
    : new TextDecoder().decode(generation.postponed);
}

/** The postponed state of a server action, asked for under `route` (`actionPostponedEarly`). */
interface EarlyPostponed {
  readonly route: string;
  readonly postponed: Promise<string | undefined>;
}

/**
 * The postponed state a server action's re-render is handed (`actionPostponedFor`), asked for as
 * the route's module is evaluated rather than once it has been. The module is evaluated before
 * anything is answered, on purpose (`entryFor`), and the generation the page was answered from is a
 * read of its record — 200 ms at the most, and as long again for a newer one (`currentGeneration`)
 * — that needs nothing of the module: asked one after the other, they came to their sum in front of
 * the action's answer, and now to the longer of the two.
 *
 * Only where it will be asked for once the module is in: an action handed state, under the route
 * `renderedBy` comes to (`routeRenderedBy`), of a Node.js entrypoint — an edge page's action is handed
 * none — and with a cache to read the generation from. A read asked for and not taken costs a read
 * of the record, kept for the requests after it; one that fails is caught here, as the module's
 * evaluation can fail before it is awaited, and fails the action where it is taken, as it would
 * have.
 */
function actionPostponedEarly(
  input: RoutedInput,
  store: Store,
  resolved: Resolved,
): EarlyPostponed | undefined {
  if (input.cache === undefined || !isActionHandedState(input.request, store)) {
    return undefined;
  }
  const route = routeRenderedBy(input, store, resolved);
  if (route === undefined || input.edge.entries[route] !== undefined) {
    return undefined;
  }
  const postponed = actionPostponedFor(
    input,
    store,
    route === resolved.route ? resolved : { ...resolved, route },
  );
  // eslint-disable-next-line unicorn/prefer-await -- Awaited where it is taken, after the module.
  postponed.catch(() => {
    // Its failure is the action's once it is taken, and nothing's where it is not.
  });
  return { route, postponed };
}

/**
 * The postponed state an action's re-render under `resolved` is handed: the one asked for early,
 * where it was asked for under the route the module renders (`actionPostponedEarly`), as it always
 * is but where `renderedBy` and the tables part; asked for now otherwise.
 */
function postponedUnder(
  input: RoutedInput,
  store: Store,
  resolved: Resolved,
  early: EarlyPostponed | undefined,
): Promise<string | undefined> {
  return early?.route === resolved.route
    ? early.postponed
    : actionPostponedFor(input, store, resolved);
}

/** A request with a body, answered by its route's handler; `undefined` where no handler has it. */
export async function serveWithBody(
  input: RoutedInput,
  store: Store,
  resolved: Resolved,
): Promise<Response | undefined> {
  const early = actionPostponedEarly(input, store, resolved);
  const rendered = await renderedBy(input, store, resolved);
  if (rendered === undefined) {
    return undefined;
  }
  const { entry } = rendered;
  const onFailure = failureAnswer(store, entry, rendered.resolved.route);
  const postponed =
    entry.kind === 'node'
      ? await postponedUnder(input, store, rendered.resolved, early)
      : undefined;
  if (postponed === undefined || entry.kind === 'edge') {
    return invokeEntry(input, entry, rendered.resolved.url, { onFailure });
  }
  return invokeNodeHandler({
    handler: entry.handler,
    request: input.request,
    url: rendered.resolved.url,
    requestMeta: { ...baseRequestMeta(input), postponed },
    waitUntil: input.waitUntil,
    run: input.run,
    onFailure,
  });
}
