import type { Prerender } from '@stayingupwind/core/bundle';
import { NEXT_ACTION_HEADER } from '@stayingupwind/core/request';

import { nowMs } from './cache/clock.ts';
import { currentGeneration } from './cache/current.ts';
import { postponedOf } from './documents.ts';
import { isDraftRequest } from './draft.ts';
import { type Entry, entryFor } from './entries.ts';
import { failureAnswer } from './error-pages.ts';
import { descriptorFor } from './generations.ts';
import { invokeNodeHandler } from './node-bridge.ts';
import type { Resolved } from './outputs.ts';
import { baseRequestMeta, invokeEntry, type RoutedInput } from './serve.ts';
import { entrypointKindOf, findShell, type Store } from './store.ts';

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
): Promise<{ readonly entry: Entry; readonly resolved: Resolved } | undefined> {
  const own = await entryFor(input, resolved.route);
  if (own !== undefined) {
    return { entry: own, resolved };
  }
  // The member's own prerender, where the build made one; else the class the router resolved the
  // member to by its name (`resolvedByName`), whose route is the member's.
  const route = (
    store.prerendersByPathname.get(resolved.pathname) ??
    store.prerendersByPathname.get(resolved.route)
  )?.route;
  if (route === undefined) {
    return undefined;
  }
  const entry = await entryFor(input, route);
  return entry === undefined ? undefined : { entry, resolved: { ...resolved, route } };
}

/** A generation a page was answered from, and its postponed state: none where it rendered whole. */
interface AnsweredFrom {
  readonly postponed: Uint8Array | undefined;
}

/**
 * The generation a page was answered from, for an action posted to it: the member's own where the
 * edge had one made for it (`concreteUpgrade`, `generations.ts`), else the class shell's the
 * member was answered from, for a member of a route whose shell has a body. The two are read at
 * once, so a member costs the action no more than one read's wait. None without a cache.
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
  if (shell.body === undefined || shell.pathname === pathname) {
    return generationOf(pathname);
  }
  const [own, ofClass] = await Promise.all([generationOf(pathname), generationOf(shell.pathname)]);
  return own ?? ofClass;
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
    !input.request.headers.has(NEXT_ACTION_HEADER) ||
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

/** A request with a body, answered by its route's handler; `undefined` where no handler has it. */
export async function serveWithBody(
  input: RoutedInput,
  store: Store,
  resolved: Resolved,
): Promise<Response | undefined> {
  const rendered = await renderedBy(input, store, resolved);
  if (rendered === undefined) {
    return undefined;
  }
  const { entry } = rendered;
  const onFailure = failureAnswer(store, entry, rendered.resolved.route);
  const postponed =
    entry.kind === 'node' ? await actionPostponedFor(input, store, rendered.resolved) : undefined;
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
