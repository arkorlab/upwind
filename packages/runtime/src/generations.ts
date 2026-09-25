import { pagesDataPathname, queryDependent } from '@upwind/core/bundle';
import type { DecodedGenerationPack, RouteEntryDescriptor } from '@upwind/core/cache';
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
  SERVED_GENERATION_HEADER,
} from '@upwind/core/paas';
import { NULL_BODY_STATUSES } from '@upwind/core/request';
import { releaseStream } from '@upwind/core/util';

import type { NodeHandler } from './app-module.ts';
import { cacheLifetimeOf, type CapturedRender, renderCaptured } from './cache/capture.ts';
import { nowMs } from './cache/clock.ts';
import { currentGeneration } from './cache/current.ts';
import type { AttemptReason, ServedObservation } from './cache/host.ts';
import { regenerate, type RegenerationOutcome, servable } from './cache/regenerate.ts';
import type { CacheRuntime } from './cache/runtime.ts';
import { nodeHandlerOf } from './entries.ts';
import { invokeNodeHandler } from './node-bridge.ts';
import {
  answerHeaders,
  PAGES_DATA,
  type Representation,
  ROUTE_BODY,
  SEGMENT_PREFIX,
} from './representations.ts';
import {
  baseRequestMeta,
  bypassesPrerender,
  concatShell,
  NEXT_CACHE_HEADER,
  type NextCacheState,
  resume,
  resumeUrl,
  type RoutedInput,
  stripPlatformHeaders,
} from './serve.ts';
import { entrypointKindOf, findShell, type Store } from './store.ts';

/**
 * The runtime cache's part in answering a request: a regeneration the edge asked for beside a
 * resume, in the foreground, or on its own; and, for what the Worker answers itself — a document,
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

/**
 * A shell that stands for a class of URLs (`/items/[id]`): Next.js's fallback shell, rendered
 * with its parameters unresolved, from which a member the build did not prerender is served and
 * resumed under its own path. It is regenerated as it was made — by a render of the template
 * pathname itself, whose placeholder parameters Next.js keeps as they are rather than reading
 * them as values (`route-module.js`, `prepare`: "literal slug matches"), and defers, which gives
 * the fallback shell again. Only an App Router page renders one at request time: a Pages Router
 * `fallback: true` document is the build's alone.
 */
function isClassShell(pathname: string): boolean {
  return pathname.includes('[');
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

/** `<generationId>;colo=<colo>;at=<ms>`: what the edge observed when it asked. */
function observationOf(request: Request): ServedObservation | undefined {
  const value = request.headers.get(SERVED_GENERATION_HEADER);
  if (value === null) {
    return undefined;
  }
  const [generationId = '', ...parts] = value.split(';');
  const fields = new Map(parts.map((part) => part.split('=', 2) as [string, string | undefined]));
  const at = Number(fields.get('at'));
  if (generationId === '' || !Number.isSafeInteger(at)) {
    return undefined;
  }
  const colo = fields.get('colo');
  return { generationId, at, ...(colo !== undefined && colo !== '' && { colo }) };
}

interface Target {
  readonly descriptor: RouteEntryDescriptor;
  readonly handler: NodeHandler;
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

/** Once the response has gone out in full, do this: the visitor's bytes come first. */
function afterBody(response: Response, then: () => void): Response {
  if (response.body === null) {
    then();
    return response;
  }
  const through = new TransformStream<Uint8Array, Uint8Array>({
    flush() {
      then();
    },
  });
  return new Response(response.body.pipeThrough(through), response);
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

/** What a request wants of an entry: which output, for which URL. */
interface Want {
  readonly representation: Representation;
  /** The path and query the resume renders for. */
  readonly url: string;
  /** A static RSC prefetch may use the captured payload without rendering its dynamic holes. */
  readonly prefetch?: boolean | undefined;
}

interface Answer extends Want {
  readonly body: Uint8Array;
  readonly postponed: string | undefined;
  /** Whether the page leaves parts of itself to a resume: it has a postponed state. */
  readonly partial: boolean;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Where the answer came from, said only of one complete without a resume (`NEXT_CACHE_HEADER`). */
  readonly cache: NextCacheState;
}

/** The visitor's answer: a document — a shell, then their own resume of it — or an output whole. */
function answerWith(input: RoutedInput, handler: NodeHandler, answer: Answer): Response {
  const headers = answerHeaders(answer.representation, answer.headers, answer.partial);
  if (answer.postponed === undefined) {
    headers.set(NEXT_CACHE_HEADER, answer.cache);
  }
  const { status } = answer;
  // A `204` a handler answered is kept with the empty body it was captured as, and a `Response`
  // refuses a body under such a status even when it is empty.
  if (input.request.method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
    return new Response(null, { status, headers });
  }
  if (answer.postponed === undefined) {
    return new Response(answer.body as BodyInit, { status, headers });
  }
  const rest = resume({ input, handler, postponed: answer.postponed, url: answer.url });
  return new Response(concatShell(answer.body, rest), { status, headers });
}

/** The output of a render a want names, as the render captured it. */
function renderedOutput(
  render: CapturedRender,
  representation: Representation,
): Uint8Array | undefined {
  if (representation === PAGES_DATA) {
    return render.data;
  }
  if (representation === 'rsc') {
    return render.rscData;
  }
  return representation.startsWith(SEGMENT_PREFIX)
    ? render.segments.get(representation.slice(SEGMENT_PREFIX.length))
    : render.html;
}

/** The visitor's answer from a render; `undefined` when the render has no such output. */
async function answerFromRender(
  input: RoutedInput,
  handler: NodeHandler,
  render: CapturedRender,
  want: Want,
): Promise<Response | undefined> {
  const resumed = resumeRsc(input, handler, want, render.postponed);
  if (resumed !== undefined) {
    return resumed;
  }
  const body = renderedOutput(render, want.representation);
  if (body === undefined) {
    return undefined;
  }
  return answerWith(input, handler, {
    ...want,
    body,
    postponed: want.representation === 'html' ? render.postponed : undefined,
    partial: render.postponed !== undefined,
    status: render.status,
    headers: render.headers,
    cache: 'MISS',
  });
}

/**
 * A captured RSC payload contains only the static prerender. An actual navigation needs Next.js
 * to render the whole Flight response using this generation's resume cache and this visitor's
 * request. That response is complete in its own right: concatenating the captured payload would
 * duplicate its Flight records. Prefetches and individual segments keep their static artifacts.
 */
function resumeRsc(
  input: RoutedInput,
  handler: NodeHandler,
  want: Want,
  postponed: string | Uint8Array | undefined,
): Promise<Response> | undefined {
  if (postponed === undefined || want.prefetch === true || want.representation !== 'rsc') {
    return undefined;
  }
  return resume({
    input,
    handler,
    postponed: typeof postponed === 'string' ? postponed : new TextDecoder().decode(postponed),
    url: want.url,
  });
}

/** What the edge asks for on a document's behalf: the document itself. */
function documentWant(input: RoutedInput): Want {
  return { representation: 'html', url: resumeUrl(input.request) };
}

/**
 * A render off its response for this visitor alone, streamed as it is rendered: a Pages Router
 * page's, at its data route when its data is what is wanted, or a route handler's. `undefined`
 * when it turns out to be dynamic here, as a capture would have said.
 */
async function streamForVisitor(
  input: RoutedInput,
  target: Target,
  want: Want,
  headers: Headers,
): Promise<Response | undefined> {
  // One output is all such a render is, and a payload or a segment is none it has, as a capture
  // of it found: a page's is the only kind that has those.
  if (want.representation === 'rsc' || want.representation.startsWith(SEGMENT_PREFIX)) {
    return undefined;
  }
  const path = want.representation === PAGES_DATA ? want.url : target.descriptor.pathname;
  const response = await invokeNodeHandler({
    handler: target.handler,
    request: new Request(new URL(path, input.request.url), { headers }),
    url: path,
    requestMeta: baseRequestMeta(input),
    waitUntil: input.waitUntil,
    run: input.run,
  });
  if (cacheLifetimeOf(response) === undefined) {
    releaseStream(response.body, 'dynamic here: the usual path answers');
    return undefined;
  }
  const init = {
    status: response.status,
    headers: answerHeaders(want.representation, Object.fromEntries(response.headers), false),
  };
  // The render is a `GET`'s, as a generation's is: a `HEAD` is told what that says of the entity,
  // as `answerWith` tells it, and is sent none of it.
  if (input.request.method === 'HEAD') {
    releaseStream(response.body, 'a HEAD is answered without the body');
    return new Response(null, init);
  }
  return new Response(response.body, init);
}

/**
 * A static render for this visitor alone, when the entry cannot be regenerated right now (a
 * lease held elsewhere, a host out of reach, a render too large for any generation): the
 * entry as a regeneration would have made it, kept by no one. `undefined` when it turns out to be
 * dynamic here.
 *
 * Only a page's render is captured for it, since the answer is assembled from it: a shell, then
 * the visitor's own resume. A Pages Router page's render and a route handler's are the answer as
 * they stand, and are streamed rather than read whole first — read, a body too large to publish
 * would be held whole again, on every request, for as long as the entry could not be published.
 */
async function renderForVisitor(
  input: RoutedInput,
  target: Target,
  want: Want,
): Promise<Response | undefined> {
  const headers = stripPlatformHeaders(input.request.headers);
  headers.delete('cookie');
  const { kind, pathname } = target.descriptor;
  if (kind !== 'app-page') {
    return streamForVisitor(input, target, want, headers);
  }
  const url = new URL(pathname, input.request.url);
  const render = await renderCaptured(kind, (meta) => {
    return invokeNodeHandler({
      handler: target.handler,
      request: new Request(url, { headers }),
      url: pathname,
      requestMeta: { ...baseRequestMeta(input), ...meta.requestMeta },
      waitUntil: input.waitUntil,
      run: input.run,
      expectNoResponse: meta.expectNoResponse,
    });
  });
  return render === undefined ? undefined : answerFromRender(input, target.handler, render, want);
}

/**
 * The visitor's answer from a regeneration just made: the render published, when one was; their
 * own render when the entry could not be published now; nothing when the entry is dynamic here,
 * which leaves the request to the usual path.
 *
 * A generation published as something a visitor may not be answered with — a redirect that does
 * not say where it leads — is one the visitor never saw, so the outcome the response carries says
 * so rather than `published`, which whatever reads it would take for the bytes that went out.
 */
async function answerFromJob(
  job: Job,
  outcome: RegenerationOutcome,
  want: Want,
): Promise<Response | undefined> {
  if (outcome.kind === 'published' && servable(outcome.render.status, outcome.render.headers)) {
    const answered = await answerFromRender(job.input, job.target.handler, outcome.render, want);
    return answered === undefined ? undefined : withOutcome(answered, 'committed');
  }
  if (outcome.kind === 'skipped') {
    return undefined;
  }
  const own = await renderForVisitor(job.input, job.target, want);
  const said = outcome.kind === 'published' ? 'unservable' : outcome.kind;
  return own === undefined ? undefined : withOutcome(own, said);
}

export interface ForegroundAnswer {
  readonly response: Response | undefined;
  /** What to say of the regeneration when the usual path answers instead. */
  readonly outcome: string;
}

/**
 * No valid generation exists: render one now, publish it, and answer the visitor from it. A page
 * that cannot be regenerated, or that is not one a cache may hold, is left to the usual path.
 */
export async function handleForeground(
  input: RoutedInput,
  store: Store,
): Promise<ForegroundAnswer> {
  const job = await jobOf(input, store);
  if (job === undefined) {
    return { response: undefined, outcome: 'skipped' };
  }
  const outcome = await runJob(job, 'expired');
  return {
    response: await answerFromJob(job, outcome, documentWant(input)),
    outcome: outcome.kind,
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
 * generation answers: no cache, a draft or a bypass condition, an output that depends on a query
 * its route does not name (no one generation stands for it), or an entry never regenerated.
 */
function answerableEntry(input: RoutedInput, store: Store, source: GenerationSource) {
  const runtime = input.cache;
  const shell =
    store.prerendersByPathname.get(source.pathname) ??
    findShell(store, source.route, source.pathname);
  if (
    runtime === undefined ||
    bypassesPrerender(store, input.request, shell, source.url) ||
    queryDependent(shell, source.route, source.pathname)
  ) {
    return;
  }
  const descriptor = descriptorFor(store, source.route, source.pathname);
  return regenerable(descriptor) ? { runtime, descriptor } : undefined;
}

/**
 * What the Worker answers itself, from the entry's current generation: fresh or stale it is
 * served (stale, regenerated behind); expired, it is regenerated first; missing, rendered now
 * where the build made none. `undefined` leaves the build's own output to answer: no generation
 * where the build has one, a host out of reach (an answer is still given, and the record
 * asked for again on the next hold), a Pages Router class shell, or an entry dynamic here.
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
  const lookup = await currentGeneration(runtime, descriptor, nowMs());
  const job: Job = { input, store, runtime, target: { descriptor, handler } };
  const want: Want = {
    representation: source.representation,
    url: source.url,
    prefetch: source.prefetch,
  };
  if (lookup.kind === 'none' && source.onMiss === 'render') {
    return answerFromJob(job, await runJob(job, 'miss'), want);
  }
  if (lookup.kind !== 'generation') {
    return undefined;
  }
  const { pack, validity } = lookup.current;
  // Once a runtime generation exists, its missing/rejected output must never fall back to
  // a different generation's build artifact. Render the original request instead.
  const renderRequest = () => resume({ input, handler, postponed: undefined, url: source.url });
  if (validity === 'expired') {
    return (await answerFromJob(job, await runJob(job, 'expired'), want)) ?? renderRequest();
  }
  if (validity === 'stale') {
    scheduleJob(job, 'stale', pack.header.generationId);
  }
  // What the record says is what the visitor would be told, and a record that cannot be answered
  // as written is not: the visitor gets a render of their own, as they would from a publish of it.
  if (!servable(pack.header.status, pack.header.headers)) {
    return (await renderForVisitor(input, job.target, want)) ?? renderRequest();
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
    return pack.header.source === 'runtime' ? renderRequest() : undefined;
  }
  return answerWith(input, handler, {
    ...want,
    body,
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
