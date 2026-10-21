import {
  isPagesDataPathname,
  pageOfDataPathname,
  type Prerender,
  staticFallbackPageFor,
  staticFallbackPagesOf,
} from '@stayingupwind/core/bundle';
import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { GENERATION_HEADER } from '@stayingupwind/core/paas';

import { afterBody } from './after-body.ts';
import type { Want } from './answers.ts';
import type { NodeHandler } from './app-module.ts';
import { settledWithin } from './cache/pulls.ts';
import type { RegenerationOutcome } from './cache/regenerate.ts';
import { documentFromBuild } from './documents.ts';
import type { GenerationSource } from './generation-source.ts';
import type { Resolved } from './outputs.ts';
import { PAGES_DATA } from './representations.ts';
import type { RoutedInput } from './serve.ts';
import { completedShell, findShell, generationPathname, type Store } from './store.ts';

/** Only version3 foreground data requests wait for their paired publication before answering. */
const PAGES_DATA_PUBLISH_MS = 10_000;

/** A supported data URL names its page's entry, never a generation keyed by the JSON pathname. */
export function foregroundPagesPathname(
  store: Store,
  route: string,
  pathname: string,
): string | undefined {
  const { buildId, config } = store.manifest;
  const page = pageOfDataPathname(buildId, config.basePath, pathname);
  const authority =
    page === undefined ? undefined : staticFallbackPageFor(store.manifest, route, page);
  if (authority?.dataPathname === pathname) return page;
  return isPagesDataPathname(config.basePath, pathname) &&
    staticFallbackPagesOf(store.manifest).some((fallback) => fallback.route === route)
    ? undefined
    : pathname;
}

/** Only an independently admitted class permits a runtime generation for this concrete member. */
export function fallbackMemberPathname(
  store: Store,
  route: string,
  pathname: string,
): string | undefined {
  return staticFallbackPageFor(store.manifest, route, pathname)?.kind === 'fallback'
    ? pathname
    : undefined;
}

/** The existing shell key, except an admitted loading class whose members publish independently. */
export function entryPathnameFor(store: Store, route: string, pathname: string): string {
  const member = fallbackMemberPathname(store, route, pathname);
  if (member !== undefined) return member;
  const shell = findShell(store, route, pathname);
  return shell === undefined ? pathname : generationPathname(shell, pathname);
}

export function firstFallbackMember(
  input: RoutedInput,
  store: Store,
  descriptor: RouteEntryDescriptor,
): boolean {
  return (
    !input.request.headers.has(GENERATION_HEADER) &&
    fallbackMemberPathname(store, descriptor.route, descriptor.pathname) !== undefined
  );
}

/** Existing document keys remain unchanged; a version3 loading shell names the member it starts. */
export function documentGenerationSource(
  store: Store,
  shell: Prerender,
  resolved: Resolved,
  crawled: boolean,
): GenerationSource {
  const fallback =
    !crawled && fallbackMemberPathname(store, resolved.route, resolved.pathname) !== undefined;
  const pathname = fallback ? resolved.pathname : generationPathname(shell, resolved.pathname);
  const built = shell.body !== undefined && !crawled && pathname === shell.pathname;
  let onMiss: GenerationSource['onMiss'] = 'render';
  if (built) onMiss = 'build';
  if (fallback) onMiss = 'behind';
  return {
    route: shell.route,
    pathname: crawled ? completedShell(shell, resolved.pathname) : pathname,
    url: resolved.url,
    representation: 'html',
    onMiss,
    pagesFallback: fallback,
  };
}

/** First bytes of the build-owned loading shell precede the member's first background render. */
export async function loadingFallbackResponse(
  {
    input,
    store,
    target,
  }: {
    readonly input: RoutedInput;
    readonly store: Store;
    readonly target: { readonly handler: NodeHandler };
  },
  source: GenerationSource,
  schedule: () => void,
): Promise<Response> {
  const { handler } = target;
  const response = await documentFromBuild(
    input,
    store,
    { route: source.route, pathname: source.pathname, url: source.url },
    { entry: { kind: 'node', handler }, status: 200 },
  );
  return afterBody(response, schedule);
}

/** Foreground data waits only for an owned publication; the host must still verify its record. */
export async function foregroundPagesData(
  input: RoutedInput,
  store: Store,
  descriptor: RouteEntryDescriptor,
  outcome: RegenerationOutcome,
): Promise<Want | undefined> {
  const url = new URL(input.request.url);
  const data = staticFallbackPageFor(
    store.manifest,
    descriptor.route,
    descriptor.pathname,
  )?.dataPathname;
  if (data !== url.pathname) return undefined;
  if ((outcome.kind === 'accepted' || outcome.kind === 'busy') && outcome.published !== undefined) {
    // Timeout or refused publication leaves the Function response private; neither is authority.
    await settledWithin(outcome.published, PAGES_DATA_PUBLISH_MS);
  }
  return { representation: PAGES_DATA, url: `${data}${url.search}` };
}
