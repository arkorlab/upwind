import { AsyncLocalStorage } from 'node:async_hooks';

import { pagesDataPathname, queryDependent } from '@stayingupwind/core/bundle';
import {
  type DecodedGenerationPack,
  type InvalidationState,
  normalizeRoutePathname,
  type RouteEntryDescriptor,
} from '@stayingupwind/core/cache';
import {
  CACHE_OUTCOME_HEADER,
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_ROUTE_HEADER,
  CACHE_UPGRADE_HEADER,
  GENERATION_HEADER,
  isRegenerateMode,
  pathFromHeaders,
  REGENERATE_HEADER,
  type RegenerateMode,
} from '@stayingupwind/core/paas';

import {
  answerFromRender,
  answerWith,
  documentWant,
  renderForVisitor,
  resumeRsc,
  type Target,
  type Want,
} from './answers.ts';
import type { NodeHandler } from './app-module.ts';
import { nowMs } from './cache/clock.ts';
import { type CurrentGeneration, currentGeneration } from './cache/current.ts';
import type { AttemptReason } from './cache/host.ts';
import { regenerate, type RegenerationOutcome, servable } from './cache/regenerate.ts';
import type { CacheRuntime } from './cache/runtime.ts';
import { nodeHandlerOf } from './entries.ts';
import { observationOf } from './incoming.ts';
import { PAGES_DATA, ROUTE_BODY, SEGMENT_PREFIX } from './representations.ts';
import { bypassesPrerender, resume, type RoutedInput } from './serve.ts';
import { entrypointKindOf, findShell, isClassShell, type Store } from './store.ts';

/**
 * The runtime cache's part in answering a request: a regeneration the edge asked for beside a
 * resume, in the foreground, or on its own; and, for what the Function answers itself — a document,
 * a Pages Router page's data, a route handler's body — the current generation rather than the
 * build's output. A resume from a generation's state the edge sent in the body is
 * `runtime-resume.ts`'s.
 *
 * A regeneration is a static render of the entry kept for everyone; a visitor's own render is
 * theirs and is never what is published: in the foreground the page is rendered twice — once
 * statically, to publish, and once resumed from that render, for the visitor.
 */

const HTTP_ACCEPTED = 202;

export function regenerateMode(request: Request): RegenerateMode | undefined {
  const value = request.headers.get(REGENERATE_HEADER);
  return value !== null && isRegenerateMode(value) ? value : undefined;
}

/** Whether the cache may hold a generation of the entry made at request time. */
function regenerable(descriptor: RouteEntryDescriptor): boolean {
  return descriptor.kind !== 'pages' || !isClassShell(descriptor.pathname);
}

/**
 * The entry a request for `pathname` under `route` is answered from: the pathname's own — a
 * member the build prerendered, keyed as the seed keyed it, or one it never saw, whose entry the
 * lease creates — or the class shell's, when the build made one and none for the member.
 */
function entryPathnameOf(store: Store, route: string, pathname: string): string {
  const shell = findShell(store, route, pathname);
  return shell?.body === undefined ? pathname : shell.pathname;
}

/** The kind of entry a route makes, from the entrypoint the build recorded for it. */
export function descriptorFor(store: Store, route: string, pathname: string): RouteEntryDescriptor {
  const entrypoint = entrypointKindOf(store, route);
  if (entrypoint === 'pages') {
    return { kind: 'pages', route, pathname };
  }
  return { kind: entrypoint === 'app-route' ? 'app-route' : 'app-page', route, pathname };
}

/** One regeneration as a request asks for it: the entry, and what it takes to render it. */
interface Job {
  readonly input: RoutedInput;
  readonly store: Store;
  readonly runtime: CacheRuntime;
  readonly target: Target;
}

/**
 * The entry the edge names: the route header, and the entry the URL's pathname is answered from
 * — its own, or the class shell's the edge served for it; the member's own, where the class
 * shell answers it, when the edge asks for that (`concreteUpgrade`: a shell rendered for the
 * member's parameters, an entry of its own). `undefined` when the request names no entry a
 * regeneration may make: no route, a route on the edge runtime (whose render nothing here
 * captures), or a Pages Router class shell.
 */
async function targetOf(input: RoutedInput, store: Store): Promise<Target | undefined> {
  const route = pathFromHeaders(
    input.request.headers,
    CACHE_ROUTE_HEADER,
    CACHE_ROUTE_ESCAPED_HEADER,
  );
  if (route === undefined) {
    return undefined;
  }
  const handler = await nodeHandlerOf(input, route);
  if (handler === undefined) {
    return undefined;
  }
  const asked = new URL(input.request.url).pathname;
  const member = input.request.headers.has(CACHE_UPGRADE_HEADER) && !isClassShell(asked);
  const pathname = member ? asked : entryPathnameOf(store, route, asked);
  const shell = store.prerendersByPathname.get(pathname) ?? findShell(store, route, pathname);
  if (bypassesPrerender(store, input.request, shell) || queryDependent(shell, route, pathname)) {
    return undefined;
  }
  const descriptor = descriptorFor(store, route, pathname);
  return regenerable(descriptor) ? { descriptor, handler } : undefined;
}

async function jobOf(input: RoutedInput, store: Store): Promise<Job | undefined> {
  const runtime = input.cache;
  const target = await targetOf(input, store);
  return runtime === undefined || target === undefined
    ? undefined
    : { input, store, runtime, target };
}

function runJob(job: Job, reason: AttemptReason): Promise<RegenerationOutcome> {
  const { input, store, target } = job;
  const { descriptor } = target;
  return regenerate({
    runtime: job.runtime,
    request: input.request,
    handler: target.handler,
    target: {
      descriptor,
      reason,
      allowHeader: (
        store.prerendersByPathname.get(descriptor.pathname) ??
        findShell(store, descriptor.route, descriptor.pathname)
      )?.allowHeader,
      observation: observationOf(input.request),
      dataPathname:
        descriptor.kind === 'pages'
          ? pagesDataPathname(store.manifest.buildId, descriptor.pathname)
          : undefined,
    },
    previewToken: store.manifest.bypassToken,
    waitUntil: input.waitUntil,
    run: input.run,
  });
}

/**
 * Regenerate after the response, once per generation of an entry per hold: the edge asks on every
 * stale request, and one regeneration at a time is what the lease allows anyway.
 *
 * Once per generation, named by the one it replaces — the one served, or the one the edge says it
 * served (`x-arkor-generation`) — rather than once per entry: a generation a regeneration has just
 * published, invalidated in turn, asks for a regeneration of its own. Kept per entry, a
 * `revalidateTag` within the hold of the regeneration before it was answered with the page as it
 * was until the hold ran out (`non-ascii-cache-tags`).
 */
function scheduleJob(job: Job, reason: AttemptReason, base?: string): boolean {
  const { descriptor } = job.target;
  const replaced = base ?? job.input.request.headers.get(GENERATION_HEADER) ?? '';
  const key = `${descriptor.route}|${descriptor.pathname}|${replaced}`;
  if (job.runtime.regenerationMemo.get(key) !== undefined) {
    return false;
  }
  job.runtime.regenerationMemo.set(key, true);
  job.input.waitUntil(runJob(job, reason));
  return true;
}

function withOutcome(response: Response, outcome: string): Response {
  const headers = new Headers(response.headers);
  headers.set(CACHE_OUTCOME_HEADER, outcome);
  return new Response(response.body, { status: response.status, headers });
}

/** Answer at once; the regeneration runs after, on its own. */
export async function handleDetached(input: RoutedInput, store: Store): Promise<Response> {
  const job = await jobOf(input, store);
  const scheduled = job !== undefined && scheduleJob(job, 'stale');
  return new Response(null, {
    status: HTTP_ACCEPTED,
    headers: { [CACHE_OUTCOME_HEADER]: scheduled ? 'accepted' : 'skipped' },
  });
}

/**
 * Once the response is done with, do this, once: the visitor's bytes come first. Done with is sent
 * in full, or given up by the client. A client cancels prefetches as a matter of course — every
 * one a navigation overtakes — and a regeneration begun only once the body had been read to its
 * end was never begun behind one that was cancelled: an entry only ever prefetched stayed stale,
 * or expired, and each expired prefetch paid for a render of its own every time.
 */
function afterBody(response: Response, then: () => void): Response {
  const { body } = response;
  if (body === null) {
    then();
    return response;
  }
  // Run in the request's context, whoever reads the body: the runtime writing the response out
  // reads it from outside the request, and a regeneration begun from that read ran outside it too
  // — under workerd its generation was stamped with the wall clock rather than the request's.
  const later = AsyncLocalStorage.bind(then);
  let done = false;
  const once = (): void => {
    if (!done) {
      done = true;
      later();
    }
  };
  const reader = body.getReader();
  const through = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (error) {
        // A body that fails part way has still been sent all it will be: the entry is as stale as
        // it was, and its regeneration no less due.
        once();
        throw error;
      }
      if (read.done) {
        controller.close();
        once();
        return;
      }
      controller.enqueue(read.value);
    },
    cancel(reason) {
      once();
      return reader.cancel(reason);
    },
  });
  return new Response(through, response);
}

/** `background`: the resume the edge asked for is answered, and the entry regenerated behind it. */
export async function withBackgroundRegeneration(
  input: RoutedInput,
  store: Store,
  response: Response,
): Promise<Response> {
  if (regenerateMode(input.request) !== 'background') {
    return response;
  }
  const job = await jobOf(input, store);
  if (job === undefined) {
    return withOutcome(response, 'skipped');
  }
  return afterBody(withOutcome(response, 'accepted'), () => {
    scheduleJob(job, 'stale');
  });
}

/**
 * The visitor's answer from a regeneration just made: the render, as soon as it is made, its
 * publish still under way behind the answer — which the outcome says (`accepted`) rather than claim
 * a commit the bytes went out ahead of; their own render when the entry could not be published
 * now; nothing when the entry is dynamic here, which leaves the request to the usual path.
 *
 * A render published as something a visitor may not be answered with — a redirect that does not
 * say where it leads — is one the visitor never saw, so the outcome the response carries says so
 * rather than `accepted`, which whatever reads it would take for the bytes that went out.
 */
async function answerFromJob(
  job: Job,
  outcome: RegenerationOutcome,
  want: Want,
): Promise<Response | undefined> {
  if (outcome.kind === 'accepted' && servable(outcome.render.status, outcome.render.headers)) {
    const answered = await answerFromRender(job.input, job.target.handler, outcome.render, want);
    return answered === undefined ? undefined : withOutcome(answered, 'accepted');
  }
  if (outcome.kind === 'skipped') {
    return undefined;
  }
  const own = await renderForVisitor(job.input, job.target, want);
  const said = outcome.kind === 'accepted' ? 'unservable' : outcome.kind;
  return own === undefined ? undefined : withOutcome(own, said);
}

export interface ForegroundAnswer {
  readonly response: Response | undefined;
  /** What to say of the regeneration when the usual path answers instead. */
  readonly outcome: string;
  /** The entry a regeneration was begun of: the usual path, answering instead, begins no other. */
  readonly regenerated: RouteEntryDescriptor | undefined;
}

/**
 * No valid generation exists: render one now, answer the visitor from it, and publish it behind the
 * answer. A page that cannot be regenerated, or that is not one a cache may hold, is left to the
 * usual path.
 */
export async function handleForeground(
  input: RoutedInput,
  store: Store,
): Promise<ForegroundAnswer> {
  const job = await jobOf(input, store);
  if (job === undefined) {
    return { response: undefined, outcome: 'skipped', regenerated: undefined };
  }
  const outcome = await runJob(job, 'expired');
  return {
    response: await answerFromJob(job, outcome, documentWant(input)),
    outcome: outcome.kind,
    regenerated: job.target.descriptor,
  };
}

export function outcomeOn(response: Response, outcome: string): Response {
  return withOutcome(response, outcome);
}

export interface GenerationSource extends Want {
  readonly route: string;
  /** The entry's pathname: as the seed keyed it, or the member asked for when the build made none. */
  readonly pathname: string;
  /** A page's data route, which the build's generation of the data is read under. */
  readonly dataPathname?: string | undefined;
  /**
   * Without a record: the build's own output answers (`build`), or the entry is rendered now and
   * kept (`render`) — a member of a route the build left to the first request for it.
   */
  readonly onMiss: 'build' | 'render';
}

async function readArtifact(
  runtime: CacheRuntime,
  artifactId: string,
): Promise<Uint8Array | undefined> {
  const remembered = runtime.artifactMemo.get(artifactId);
  if (remembered !== undefined) {
    return remembered;
  }
  const bytes = await runtime.host.readArtifact(artifactId);
  if (bytes !== undefined) {
    runtime.artifactMemo.set(artifactId, bytes);
  }
  return bytes;
}

/**
 * The bytes of one output of a generation: the record carries the primary one; a page's data is
 * the build's own for the build's generation, and an artifact of the host's for the rest.
 * `undefined` when the record does not lead to it.
 */
async function outputOf(
  runtime: CacheRuntime,
  store: Store,
  pack: DecodedGenerationPack,
  source: GenerationSource,
): Promise<Uint8Array | undefined> {
  if (source.representation === 'html' || source.representation === ROUTE_BODY) {
    return pack.html;
  }
  if (pack.header.source === 'build') {
    // The build's generation names no artifacts of the host's: what the build shipped beside
    // the document is read from the bundle, and what it shipped nothing for is not there at all.
    if (source.representation !== PAGES_DATA) {
      return undefined;
    }
    const twin =
      source.dataPathname === undefined
        ? undefined
        : store.prerendersByPathname.get(source.dataPathname);
    return twin?.body === undefined ? undefined : store.readBlob(twin.body.sha256);
  }
  const ref = pack.header.artifacts.find(
    (item) => item.representationKey === source.representation,
  );
  try {
    return ref === undefined ? undefined : await readArtifact(runtime, ref.artifactId);
  } catch (error) {
    runtime.log('generation output not read', {
      pathname: source.pathname,
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * The entry a request may be answered from, and the cache it is kept in; `undefined` where no
 * generation answers: no cache, a route the build prerendered nothing of, a draft or a bypass
 * condition, an output that depends on a query its route does not name (no one generation stands
 * for it), or an entry never regenerated.
 *
 * A route with no prerender — no output of its own, no shell of its class — is one Next.js renders
 * for every request, and no generation of it is ever seeded or made: its record was asked for all
 * the same, on every navigation's payload, and each of them waited on that read, up to its
 * deadline, for an answer that could only say there was none.
 */
function answerableEntry(input: RoutedInput, store: Store, source: GenerationSource) {
  const runtime = input.cache;
  const shell =
    store.prerendersByPathname.get(source.pathname) ??
    findShell(store, source.route, source.pathname);
  if (
    runtime === undefined ||
    shell === undefined ||
    bypassesPrerender(store, input.request, shell, source.url) ||
    queryDependent(shell, source.route, source.pathname)
  ) {
    return;
  }
  const descriptor = descriptorFor(store, source.route, source.pathname);
  return regenerable(descriptor) ? { runtime, descriptor } : undefined;
}

/**
 * The same entry, as the cache keys it (`keyDescriptorFor`): a pathname with a trailing slash names
 * the entry without one. The foreground regenerates the entry by the pathname the edge asked for,
 * which keeps the slash in an application that keeps its pages there (`trailingSlash`); the usual
 * path routes it without.
 */
function sameEntry(a: RouteEntryDescriptor | undefined, b: RouteEntryDescriptor): boolean {
  return (
    a?.kind === b.kind &&
    a.route === b.route &&
    normalizeRoutePathname(a.pathname) === normalizeRoutePathname(b.pathname)
  );
}

/**
 * The request rendered as it came. Once a runtime generation exists, its missing/rejected output
 * must never fall back to a different generation's build artifact: this answers instead.
 */
const renderRequest = (job: Job, url: string): Promise<Response> =>
  resume({ input: job.input, handler: job.target.handler, postponed: undefined, url });

/**
 * A prefetch of a page or of one of its segments: asked for ahead of a navigation that may not
 * come.
 */
function speculative(want: Want): boolean {
  return want.prefetch === true || want.representation.startsWith(SEGMENT_PREFIX);
}

/** How long an expired prefetch waits for the tag delta it is behind (`renderSpeculative`). */
const SPECULATIVE_TAG_SYNC_MS = 1000;

/**
 * A prefetch's answer where the entry's generation has expired: a static render of the page made
 * for it and kept by no one, the regeneration left to after the answer.
 *
 * Next.js 16.3.6 answers such a prefetch the way it answers a document: an entry past its `expire`
 * is never early-resolved, stale bytes and all, but revalidated in the foreground, and the
 * prefetch is sent the fresh render (`ResponseCache.handleGet`, `isStale === -1`; a prefetch that
 * finds no entry runs its own render, `isPrefetch`). What the visitor is sent here is that same
 * render — the expired record is not served — but the lease, the pull of the tag delta and the
 * publish behind it are not made in front of a request the client makes speculatively, many at a
 * time, one for each segment of a page it may never visit: those segments' requests each held the
 * lease or found it held, and every one of them waited for that before it rendered. The
 * regeneration begins once the answer has gone out in full, once per generation of the entry
 * (`scheduleJob`), as a stale one's does.
 *
 * The pull is made where the invalidation that expired the entry is one this isolate's view of the
 * tags is behind (`revision`): the render reads its data values through that view, and a value the
 * invalidation reached would be taken for current and sent to the navigation that adopts the
 * prefetch. Pulled first, as a regeneration pulls it — joined with any pull out, so a page's
 * segments prefetched together pull it once, and again where a pull left the view short of the
 * record (`catchUp`) — for a second at the most (`SPECULATIVE_TAG_SYNC_MS`), past which the render
 * reads the view as it stands.
 */
async function renderSpeculative(
  job: Job,
  want: Want,
  source: GenerationSource,
  invalidation: InvalidationState | undefined,
): Promise<Response> {
  const { runtime } = job;
  if (invalidation !== undefined && invalidation.revision > runtime.tags.revision) {
    await settledWithin(catchUp(runtime, invalidation.revision), SPECULATIVE_TAG_SYNC_MS);
  }
  return (
    (await renderForVisitor(job.input, job.target, want)) ?? (await renderRequest(job, source.url))
  );
}

/**
 * The pull of the tag delta each runtime's expired prefetches have out, when it went out on the
 * isolate's own clock, and whether it has settled: the segments of a page prefetched together are
 * behind the same invalidation, and the first of them to find it pulls it for all of them. Joined
 * while it is out and younger than the hold; older, it may be a pull whose request ended under it,
 * which never answers.
 */
interface SpeculativePull {
  readonly pull: Promise<void>;
  readonly since: number;
  settled: boolean;
}

const speculativePulls = new WeakMap<CacheRuntime, SpeculativePull>();

/** How many pulls a prefetch makes or joins to bring the view up to its record's revision. */
const SPECULATIVE_PULLS = 2;

/** A pull of the delta for the prefetches after it to join while it is out. Never rejects. */
function startPull(runtime: CacheRuntime): Promise<void> {
  const underWay: { pull: Promise<void>; readonly since: number; settled: boolean } = {
    pull: Promise.resolve(),
    since: performance.now(),
    settled: false,
  };
  underWay.pull = (async () => {
    try {
      await runtime.tags.sync(runtime.host, nowMs(), { force: true });
    } catch {
      // A pull that fails leaves the view as it stood, as a regeneration's does.
    } finally {
      underWay.settled = true;
    }
  })();
  speculativePulls.set(runtime, underWay);
  return underWay.pull;
}

/**
 * Bring this isolate's view of the tags up to the revision a prefetch's record was invalidated at
 * (`required`): joining a pull that is out, or making one, and again where it left the view short —
 * a pull that went out before the invalidation answers with the revision before it.
 */
async function catchUp(runtime: CacheRuntime, required: number): Promise<void> {
  for (let tries = 0; tries < SPECULATIVE_PULLS && runtime.tags.revision < required; tries += 1) {
    const underWay = speculativePulls.get(runtime);
    const joinable =
      underWay !== undefined &&
      !underWay.settled &&
      performance.now() - underWay.since < runtime.holdMs;
    await (joinable ? underWay.pull : startPull(runtime));
  }
}

/** Once `promise` has settled, whichever way, or `ms` have gone by. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  const settled = (async () => {
    try {
      await promise;
    } catch {
      // A pull that fails leaves the view as it stood, as a regeneration's does.
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the Function answers itself, from the entry's current generation: fresh or stale it is
 * served (stale, regenerated behind); expired, it is regenerated first, or rendered for a prefetch
 * and regenerated behind; missing, rendered now where the build made none. `undefined` leaves the
 * build's own output to answer: no generation where the build has one, a host out of reach (an
 * answer is still given, and the record asked for again on the next hold), a Pages Router class
 * shell, or an entry dynamic here.
 */
export async function serveFromGeneration(
  input: RoutedInput,
  store: Store,
  source: GenerationSource,
  handler: NodeHandler,
): Promise<Response | undefined> {
  const answerable = answerableEntry(input, store, source);
  if (answerable === undefined) {
    return undefined;
  }
  const { runtime, descriptor } = answerable;
  const lookup = await currentGeneration(runtime, descriptor, nowMs(), input.waitUntil);
  const job: Job = { input, store, runtime, target: { descriptor, handler } };
  const want: Want = {
    representation: source.representation,
    url: source.url,
    prefetch: source.prefetch,
  };
  // One regeneration of an entry a request. A foreground one that answered nothing has had it
  // (`routeRequest`), and found the entry dynamic here, which is all another would find: what is
  // left is a render of the request as it came — the build's path, for an entry with no record.
  const once = !sameEntry(input.regenerated, descriptor);
  if (lookup.kind === 'none' && source.onMiss === 'render') {
    return once ? answerFromJob(job, await runJob(job, 'miss'), want) : undefined;
  }
  if (lookup.kind !== 'generation') {
    return undefined;
  }
  const { pack, validity } = lookup.current;
  if (validity === 'expired' && !once) {
    return renderRequest(job, source.url);
  }
  if (validity === 'expired' && speculative(want)) {
    return afterBody(await renderSpeculative(job, want, source, pack.header.invalidation), () => {
      scheduleJob(job, 'expired', pack.header.generationId);
    });
  }
  if (validity === 'expired') {
    const regenerated = await answerFromJob(job, await runJob(job, 'expired'), want);
    return regenerated ?? renderRequest(job, source.url);
  }
  const answer = await answerFromGeneration(job, lookup.current, source, want);
  // A stale one is regenerated once the answer has gone out in full, as it is behind a resume the
  // edge dispatched (`withBackgroundRegeneration`). Begun at once, the regeneration rendered on
  // this isolate beside the visitor's own render — their resume, where the page has one — and the
  // two shared its time. Where the generation leads to no output, the build's answers instead,
  // from the caller, and nothing here sees that answer end: the regeneration is begun at once.
  //
  // A prefetch's too, where Next.js 16.3.6 answers a stale entry to a prefetch and revalidates
  // nothing (`ResponseCache.handleGet`, `!isStale || isPrefetch`), and leaves it to the
  // navigation after. Kept on purpose: it costs the prefetch nothing, begun after its answer and
  // once a generation, and a page whose visitors mostly prefetch it — a link on every page,
  // seldom followed — would otherwise be prefetched as it was until it expired, and then cost
  // every prefetch a render of its own.
  const behind = (): boolean => once && scheduleJob(job, 'stale', pack.header.generationId);
  if (validity === 'stale' && answer !== undefined) {
    return afterBody(answer, behind);
  }
  if (validity === 'stale') {
    behind();
  }
  return answer;
}

/**
 * The visitor's answer from a generation that may be served, fresh or stale; `undefined` where it
 * leads to no output of its own, which leaves the build's to answer.
 */
async function answerFromGeneration(
  job: Job,
  { pack, validity }: CurrentGeneration,
  source: GenerationSource,
  want: Want,
): Promise<Response | undefined> {
  const { input, runtime, store } = job;
  const { handler } = job.target;
  // What the record says is what the visitor would be told, and a record that cannot be answered
  // as written is not: the visitor gets a render of their own, as they would from a publish of it.
  if (!servable(pack.header.status, pack.header.headers)) {
    return (await renderForVisitor(input, job.target, want)) ?? renderRequest(job, source.url);
  }
  // Build records hold only the document's state; let rscFromBuild choose the RSC twin's own
  // state. A runtime navigation resumes directly, without reading its static RSC artifact first.
  const resumed =
    pack.header.source === 'build' ? undefined : resumeRsc(input, handler, want, pack.postponed);
  if (resumed !== undefined) {
    return resumed;
  }
  const body = await outputOf(runtime, store, pack, source);
  if (body === undefined) {
    return pack.header.source === 'runtime' ? renderRequest(job, source.url) : undefined;
  }
  return answerWith(input, handler, {
    ...want,
    body,
    // The bytes name themselves: a regeneration that produced the same body leaves what a client
    // holds of it valid. Only a route handler's body is the record's primary, and it is the only
    // answer here that may be shared (`answerHeaders`).
    partial: pack.postponed !== undefined,
    postponed:
      source.representation === 'html' && pack.postponed !== undefined
        ? new TextDecoder().decode(pack.postponed)
        : undefined,
    status: pack.header.status,
    headers: pack.header.headers,
    cache: validity === 'stale' ? 'STALE' : 'HIT',
  });
}
