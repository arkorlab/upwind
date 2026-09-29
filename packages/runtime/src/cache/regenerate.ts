import {
  appPathFor,
  generationResponseHeaders,
  type GenerationTag,
  implicitTagsFor,
  MAX_TAGS_PER_ENTRY,
  parseCacheTagsHeader,
  policyFromCacheControl,
  type RouteEntryDescriptor,
  tagKindOf,
} from '@stayingupwind/core/cache';
import { REDIRECT_STATUSES } from '@stayingupwind/core/request';

import type { NodeHandler } from '../app-module.ts';
import { render404 } from '../error-pages.ts';
import { invokeNodeHandler, type Run } from '../node-bridge.ts';
import { type CapturedRender, renderCaptured } from './capture.ts';
import { nowMs } from './clock.ts';
import { asRegeneration } from './context.ts';
import { forgetRecord } from './current.ts';
import {
  type ArtifactUpload,
  type AttemptOutcome,
  type AttemptReason,
  CacheHostError,
  type CommitArtifact,
  type CommitOutput,
  type CommitRequest,
  type ServedObservation,
  type UploadedArtifact,
} from './host.ts';
import type { CacheRuntime } from './runtime.ts';

/**
 * A regeneration: one attempt at publishing a new generation of an entry. The lease is taken
 * from the host, the entry is rendered as a static render would render it — no cookies, no
 * body, only the headers Next.js lets an ISR render see — and what the render produced is
 * uploaded and committed as one: a page's document with the state that resumes it, its RSC
 * payload and segments; a Pages Router page's document with the data its route serves; a route
 * handler's body. A visitor's own render is never what is published: what a cookie or a header
 * made of it is theirs alone.
 *
 * The uploads and the commit go on behind whoever answers from the render, handed to the runtime
 * once the render is made: they are round trips to the host, none of which changes what the render
 * says, and a visitor answered from a render made for them waited for every one of them before
 * the first byte.
 */

const HTML_TYPE = 'text/html; charset=utf-8';
const RSC_TYPE = 'text/x-component';
const JSON_TYPE = 'application/json';
const JSON_UTF8_TYPE = 'application/json; charset=utf-8';
const OCTET_STREAM = 'application/octet-stream';
const CACHE_TAGS_HEADER = 'x-next-cache-tags';
/** The artifact role and representation of a route handler's body. */
const ROUTE_BODY = 'route-body';
/** The artifact role and representation of a Pages Router page's data. */
const PAGES_DATA = 'pages-data';
/** Headers every static render is given, as a browser navigation carries them. */
const STATIC_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  accept: 'text/html,application/xhtml+xml',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
};
/**
 * How Next.js is told that a regeneration was asked for rather than come due: the header it
 * compares against the build's own token (`checkIsOnDemandRevalidate`, `api-utils/index.ts`). It
 * is what `getStaticProps` reads as `revalidateReason: 'on-demand'`, where a render without it
 * reads `'stale'` however the regeneration came about.
 */
const ON_DEMAND_HEADER = 'x-prerender-revalidate';
/** The reasons that are somebody asking: `revalidate()`, and an invalidation of a tag. */
const ON_DEMAND_REASONS: ReadonlySet<AttemptReason> = new Set<AttemptReason>([
  'invalidated',
  'manual',
]);
const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;

interface RegenerationTarget {
  readonly descriptor: RouteEntryDescriptor;
  readonly reason: AttemptReason;
  /** The request headers Next.js lets the render see (`allowHeader`); none by default. */
  readonly allowHeader?: readonly string[] | undefined;
  readonly observation?: ServedObservation | undefined;
  /** A Pages Router page's data route, which its data output is recorded under. */
  readonly dataPathname?: string | undefined;
}

export interface RegenerationInput {
  readonly runtime: CacheRuntime;
  /** The request that asked, for its host and the headers the render may see. */
  readonly request: Request;
  readonly handler: NodeHandler;
  readonly target: RegenerationTarget;
  /**
   * The token `next build` generated for this build, which says a request may make Next.js render
   * rather than read what the build wrote. Absent for a build that generated none.
   */
  readonly previewToken: string | undefined;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly run: Run;
}

/**
 * What a regeneration came to by the time its render was made: the render, with its publish under
 * way (`accepted`); or why there is nothing to publish.
 */
export type RegenerationOutcome =
  | {
      readonly kind: 'accepted';
      readonly render: CapturedRender;
      /** The uploads and the commit, already handed to the runtime; it never rejects. */
      readonly published: Promise<PublishOutcome>;
    }
  | { readonly kind: 'busy' }
  | { readonly kind: 'skipped'; readonly render: CapturedRender | undefined }
  | { readonly kind: 'refused'; readonly reason: string }
  | {
      readonly kind: 'failed';
      readonly render: CapturedRender | undefined;
      readonly error: string;
    };

/** What the publish of a render came to, once the host has answered it. */
export type PublishOutcome =
  | { readonly kind: 'published'; readonly generationId: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: string };

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The request a static render is given: the pathname, and nothing of the visitor's. */
function staticRequest(input: RegenerationInput, attemptId: string): Request {
  const url = new URL(input.target.descriptor.pathname, input.request.url);
  const headers = new Headers(STATIC_REQUEST_HEADERS);
  const host = input.request.headers.get('host');
  if (host !== null) {
    headers.set('host', host);
  }
  if (input.target.allowHeader !== undefined) {
    for (const name of input.target.allowHeader) {
      const value = input.request.headers.get(name);
      if (value !== null) {
        headers.set(name, value);
      }
    }
  }
  // Next.js's own scoping of its minimal-mode response cache to one invocation.
  headers.set('x-invocation-id', attemptId);
  if (input.previewToken !== undefined && ON_DEMAND_REASONS.has(input.target.reason)) {
    headers.set(ON_DEMAND_HEADER, input.previewToken);
  }
  return new Request(url, { headers });
}

/**
 * Render the entry statically and keep what a cache would; nothing is answered. A Pages Router
 * render that ends in `notFound: true` asks for `render404` here as on a visitor's request, and
 * what it writes is what is kept: without it, the line of text Next.js ends with was kept, and
 * served, in place of the application's not-found page.
 */
function renderStatic(
  input: RegenerationInput,
  attemptId: string,
): Promise<CapturedRender | undefined> {
  const request = staticRequest(input, attemptId);
  return renderCaptured(input.target.descriptor.kind, (meta) => {
    return invokeNodeHandler({
      handler: input.handler,
      request,
      url: input.target.descriptor.pathname,
      requestMeta: {
        minimalMode: true,
        relativeProjectDir: '.',
        initURL: request.url,
        render404,
        ...meta.requestMeta,
      },
      waitUntil: input.waitUntil,
      run: (work) => input.run(() => asRegeneration(work)),
      expectNoResponse: meta.expectNoResponse,
    });
  });
}

/**
 * A regeneration this runtime refuses itself, under the word the attempt is recorded with.
 *
 * The gateway records whatever word a failure carries (`attemptErrorSchema.code` enumerates none),
 * so a refusal decided here is told apart in the inspector from a render that threw.
 */
class RegenerationError extends Error {
  readonly code: string;

  constructor(message: string, options: RegenerationErrorOptions) {
    super(message, options);
    this.name = 'RegenerationError';
    this.code = options.code;
  }
}

interface RegenerationErrorOptions extends ErrorOptions {
  readonly code: string;
}

/**
 * Every tag the render leaves on the entry: the ones it recorded, and the route's implicit ones.
 *
 * Refused here rather than at the gateway when there are too many. The contract bounds them
 * (`MAX_TAGS_PER_ENTRY`), and a request past that bound is turned away by a schema whose message
 * says nothing about tags — so the entry would go on failing every regeneration with no way to
 * read why. Said here, before the outputs are uploaded, the attempt carries the count and the
 * pathname into the inspector.
 */
function tagsOf(target: RegenerationTarget, render: CapturedRender): GenerationTag[] {
  const { descriptor } = target;
  const recorded = parseCacheTagsHeader(render.headers[CACHE_TAGS_HEADER]);
  const concrete = descriptor.pathname.includes('[') ? undefined : descriptor.pathname;
  const implicit =
    descriptor.kind === 'pages'
      ? []
      : implicitTagsFor(appPathFor(descriptor.kind, descriptor.route), concrete);
  const values = new Set(recorded);
  for (const value of implicit) {
    values.add(value);
  }
  if (values.size > MAX_TAGS_PER_ENTRY) {
    throw new RegenerationError(
      `the render of ${descriptor.pathname} left ${values.size} cache tags on the entry; a generation may carry ${MAX_TAGS_PER_ENTRY}`,
      { code: 'too_many_tags' },
    );
  }
  return [...values].map((value) => ({ kind: tagKindOf(value), value }));
}

interface Uploads {
  readonly body: UploadedArtifact;
  readonly postponed: UploadedArtifact | undefined;
  readonly rsc: UploadedArtifact | undefined;
  readonly data: UploadedArtifact | undefined;
  readonly segments: ReadonlyMap<string, UploadedArtifact>;
}

interface BodyArtifact {
  readonly role: CommitArtifact['role'];
  readonly contentType: string;
}

/** The primary output's artifact: a page's document, or a route handler's body as it typed it. */
function bodyArtifact(target: RegenerationTarget, render: CapturedRender): BodyArtifact {
  return target.descriptor.kind === 'app-route'
    ? { role: ROUTE_BODY, contentType: render.headers['content-type'] ?? OCTET_STREAM }
    : { role: 'html', contentType: HTML_TYPE };
}

async function upload(
  input: RegenerationInput,
  lease: { attemptId: string; fencingToken: number },
  render: CapturedRender,
): Promise<Uploads> {
  const { host } = input.runtime;
  const one = (role: ArtifactUpload['role'], bytes: Uint8Array, contentType: string) =>
    host.uploadArtifact({ ...lease, role, bytes, contentType });
  const encoder = new TextEncoder();
  const primary = bodyArtifact(input.target, render);
  // Every output at once, the segments with the rest. Each is a call of its own to the host, which
  // none of the others waits on, and one after another a page's segments were a round trip each
  // between the render and its commit. What a Function may have open at once is the runtime's to
  // bound: past that, it holds a call back until another is done rather than failing it.
  const [body, postponed, rsc, data, segments] = await Promise.all([
    one(primary.role, render.html, primary.contentType),
    render.postponed === undefined
      ? undefined
      : one('postponed', encoder.encode(render.postponed), JSON_TYPE),
    render.rscData === undefined ? undefined : one('rsc', render.rscData, RSC_TYPE),
    render.data === undefined ? undefined : one(PAGES_DATA, render.data, JSON_UTF8_TYPE),
    Promise.all(
      [...render.segments].map(
        async ([key, bytes]) => [key, await one('segment', bytes, RSC_TYPE)] as const,
      ),
    ),
  ]);
  return { body, postponed, rsc, data, segments: new Map(segments) };
}

function artifact(
  role: CommitArtifact['role'],
  uploaded: UploadedArtifact,
  contentType: string,
): CommitArtifact {
  return { role, ...uploaded, contentType };
}

/** The primary output: the document of a page, or the body of a route handler. */
function primaryOutput(
  target: RegenerationTarget,
  render: CapturedRender,
  uploads: Uploads,
): CommitOutput {
  const { pathname, kind } = target.descriptor;
  const primary = bodyArtifact(target, render);
  return {
    representationKey: kind === 'app-route' ? ROUTE_BODY : 'html',
    pathname,
    status: render.status,
    headers: render.headers,
    compute: render.postponed === undefined ? 'static' : 'resuming',
    response: render.postponed === undefined ? 'complete' : 'initial',
    htmlSize: kind === 'app-route' ? null : render.html.byteLength,
    artifacts: [
      artifact(primary.role, uploads.body, primary.contentType),
      ...(uploads.postponed === undefined
        ? []
        : [artifact('postponed', uploads.postponed, JSON_TYPE)]),
    ],
  };
}

/** A complete output beside the primary one: RSC payload, a segment, a page's data. */
function sideOutput(
  representationKey: string,
  pathname: string,
  contentType: string,
  artifacts: CommitArtifact[],
): CommitOutput {
  return {
    representationKey,
    pathname,
    status: HTTP_OK,
    headers: { 'content-type': contentType },
    compute: 'static',
    response: 'complete',
    htmlSize: null,
    artifacts,
  };
}

function outputsOf(
  target: RegenerationTarget,
  render: CapturedRender,
  uploads: Uploads,
): CommitOutput[] {
  const { pathname } = target.descriptor;
  const outputs: CommitOutput[] = [primaryOutput(target, render, uploads)];
  if (uploads.data !== undefined) {
    outputs.push(
      sideOutput(PAGES_DATA, target.dataPathname ?? pathname, JSON_UTF8_TYPE, [
        artifact(PAGES_DATA, uploads.data, JSON_UTF8_TYPE),
      ]),
    );
  }
  if (uploads.rsc !== undefined) {
    outputs.push(sideOutput('rsc', pathname, RSC_TYPE, [artifact('rsc', uploads.rsc, RSC_TYPE)]));
  }
  for (const [key, uploaded] of uploads.segments) {
    outputs.push(
      sideOutput(`segment:${key}`, pathname, RSC_TYPE, [artifact('segment', uploaded, RSC_TYPE)]),
    );
  }
  return outputs;
}

/**
 * What the render came to: the outputs that were stored, the tags it left on the entry, and the
 * revision of the tag view its reads were judged against.
 */
interface Made {
  readonly uploads: Uploads;
  readonly tags: readonly GenerationTag[];
  readonly observedTagRevision: number;
}

function commitRequest(
  input: RegenerationInput,
  lease: Leased,
  render: CapturedRender,
  made: Made,
): CommitRequest {
  const now = nowMs();
  return {
    fencingToken: lease.fencingToken,
    observedTagRevision: made.observedTagRevision,
    generation: {
      cacheTimestamp: now,
      producedAt: now,
      policy: policyFromCacheControl(render.cacheControl),
      status: render.status,
      headers: generationResponseHeaders(
        input.target.descriptor.kind,
        render.status,
        Object.entries(render.headers),
      ),
      // Handed in rather than read here, because `tagsOf` ran before the uploads did: a render
      // carrying more tags than a generation may is refused without paying to store its outputs.
      tags: [...made.tags],
      outputs: outputsOf(input.target, render, made.uploads),
      reason: input.target.reason,
    },
  };
}

async function abandon(
  input: RegenerationInput,
  lease: { attemptId: string; fencingToken: number },
  outcome: 'failed' | 'skipped',
  error?: unknown,
): Promise<void> {
  try {
    await input.runtime.host.fail(lease.attemptId, {
      fencingToken: lease.fencingToken,
      outcome,
      // The failure's own word where it has one, so a refusal decided here reads as itself and
      // not as a render that threw; the gateway enumerates none of them.
      ...(error !== undefined && {
        error: {
          code: error instanceof RegenerationError ? error.code : 'render_failed',
          message: detail(error),
        },
      }),
    });
  } catch (error_) {
    input.runtime.log('attempt not ended', { attemptId: lease.attemptId, detail: detail(error_) });
  }
}

/** End the attempt as failed, and say why in the Function's log; what it says is returned. */
async function giveUp(
  input: RegenerationInput,
  lease: Leased,
  error: unknown,
  began: number,
): Promise<string> {
  await abandon(input, lease, 'failed', error);
  input.runtime.log('regeneration failed', {
    pathname: input.target.descriptor.pathname,
    detail: detail(error),
    elapsedMs: elapsedSince(began),
  });
  return detail(error);
}

/**
 * How long the attempt has held its lease, as the logs of one that came to nothing say: its publish
 * runs behind the answer, within what the runtime gives work handed to it after the response —
 * about 30 s on Workers — and an attempt that ran out of it says nothing of its own. One that took
 * nearly all of that to fail says where the time went. Read off `performance`, as the clock is
 * (`clock.ts`), and never off a clock a test handed the request, which does not move.
 */
function elapsedSince(began: number): number {
  return Math.round(performance.now() - began);
}

type Leased = Extract<AttemptOutcome, { kind: 'leased' }>;

/** A third of what is left of the lease, and never so often that the beats are the work. */
const HEARTBEAT_DIVISOR = 3;
const MIN_HEARTBEAT_MS = 5000;

/**
 * How long a regeneration that holds its lease waits for the tags to be synced before it gives the
 * lease back. The pull pages through the scope's delta, which a fresh isolate reads from the
 * start; past this it is taken for lost — the request that began it may have ended under it, and
 * what a request left out never settles once it has — and the attempt ends as failed rather than
 * holding its lease, renewed by its heartbeat, for as long as the request lives.
 */
const TAG_SYNC_DEADLINE_MS = 10_000;

/** `promise` settled, or a `RegenerationError` saying `what` once `ms` have gone by. */
async function within(
  promise: Promise<void>,
  ms: number,
  what: { readonly code: string; readonly message: string },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new RegenerationError(`${what.message} within ${String(ms)} ms`, { code: what.code }),
          );
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keep the lease while the render, the uploads and the commit run.
 *
 * The host hands a lease out for a fixed time and gives it to someone else when it runs out,
 * and a render of a page with much to fetch plus the uploads of everything it produced can take
 * longer than that. Without a beat, exactly the pages that need the longest to build are the ones
 * whose commit is always refused, and every request for one renders it again from nothing.
 *
 * A beat that fails is not the end of the attempt: the commit is what finds out whether the lease
 * was kept, and it says so in one place.
 */
function heartbeat(input: RegenerationInput, lease: Leased): () => void {
  const remaining = lease.leaseExpiresAt - nowMs();
  const every = Math.max(Math.floor(remaining / HEARTBEAT_DIVISOR), MIN_HEARTBEAT_MS);
  const beat = async (): Promise<void> => {
    try {
      await input.runtime.host.heartbeat(lease.attemptId, lease.fencingToken);
    } catch (error) {
      input.runtime.log('lease not renewed', {
        attemptId: lease.attemptId,
        detail: detail(error),
      });
    }
  };
  const timer = setInterval(() => {
    // Handed to the runtime rather than left loose: a beat comes behind the response as often as
    // not, since the uploads and the commit do, and it is a request of its own that the isolate
    // may not be torn down in the middle of.
    input.waitUntil(beat());
  }, every);
  return () => {
    clearInterval(timer);
  };
}

/**
 * Upload what the render made and commit it, behind whoever was answered from the render, and keep
 * the lease until the host has answered. Never throws: a publish that fails or is refused is
 * logged, since the response that could have said so went out ahead of it.
 */
async function publish(
  input: RegenerationInput,
  lease: Leased,
  rendered: {
    readonly render: CapturedRender;
    readonly observedTagRevision: number;
    readonly began: number;
  },
  stopHeartbeat: () => void,
): Promise<PublishOutcome> {
  const { runtime, target } = input;
  const { render, observedTagRevision, began } = rendered;
  try {
    // Ahead of the uploads: a render the contract will not take is one whose outputs are not
    // worth sending, and what says so is `tagsOf`.
    const tags = tagsOf(target, render);
    const uploads = await upload(input, lease, render);
    const committed = await runtime.host.commit(
      lease.attemptId,
      commitRequest(input, lease, render, { uploads, tags, observedTagRevision }),
    );
    if (committed.kind === 'published') {
      return { kind: 'published', generationId: committed.generationId };
    }
    runtime.log('regeneration not published', {
      pathname: target.descriptor.pathname,
      detail: committed.reason,
      elapsedMs: elapsedSince(began),
    });
    return { kind: 'refused', reason: committed.reason };
  } catch (error) {
    return { kind: 'failed', error: await giveUp(input, lease, error, began) };
  } finally {
    stopHeartbeat();
    // Whatever came of it. A read begun since the render let go of the entry may have kept the
    // generation it replaces; published, that is not what the host serves, and refused — another
    // attempt's won — or failed with its commit landed and the answer lost, it may not be either.
    forgetRecord(runtime, lease.entryId);
  }
}

/**
 * Take the lease and render the entry — or say why there is nothing to publish — and hand the
 * uploads and the commit to the runtime. Never throws. It answers once the render is made: what
 * follows is round trips to the host that change nothing the render says, and whoever answers from
 * the render waits for none of them. `published` says what came of them.
 */
export async function regenerate(input: RegenerationInput): Promise<RegenerationOutcome> {
  const { runtime, target } = input;
  // The view of the tags the render will judge its data-cache reads against, brought up to date
  // whatever the hold says: the revision it stands at is what the commit claims the render knew,
  // and a claim older than the render is one the host refuses the generation for. Pulled beside
  // the lease rather than ahead of it, since neither needs the other and a fresh isolate's pull
  // pages through the scope's whole delta — but finished before the render begins, which is what
  // keeps the claim true: the commit claims the revision the view stood at when the render began,
  // and every read the render makes is judged against that view or one brought further along
  // since. Handed to the runtime as well, whatever the lease says: a pull cut off with its request
  // would be the one every later sync of this isolate joins.
  const synced = runtime.tags.sync(runtime.host, nowMs(), { force: true });
  input.waitUntil(synced);
  let lease: AttemptOutcome;
  try {
    lease = await runtime.host.startAttempt({
      entry: target.descriptor,
      reason: target.reason,
      ...(target.observation !== undefined && { observation: target.observation }),
    });
  } catch (error) {
    const reason =
      error instanceof CacheHostError ? `${error.code}: ${error.message}` : detail(error);
    runtime.log('regeneration not started', {
      pathname: target.descriptor.pathname,
      detail: reason,
    });
    return { kind: 'refused', reason };
  }
  if (lease.kind === 'busy') {
    return { kind: 'busy' };
  }
  const began = performance.now();
  const stopHeartbeat = heartbeat(input, lease);
  let observedTagRevision: number;
  let captured: CapturedRender | undefined;
  try {
    await within(synced, TAG_SYNC_DEADLINE_MS, {
      code: 'tags_not_synced',
      message: 'the tags were not synced',
    });
    observedTagRevision = runtime.tags.revision;
    captured = await renderStatic(input, lease.attemptId);
    if (captured === undefined) {
      stopHeartbeat();
      await abandon(input, lease, 'skipped');
      return { kind: 'skipped', render: undefined };
    }
    if (captured.status >= HTTP_SERVER_ERROR) {
      // A server error is the render failing, however it said so: kept, it would be the entry's
      // answer until its lifetime ran out. Whatever generation the entry has keeps answering, as
      // Next.js keeps the entry it had when a revalidation fails, and the host's backoff
      // decides when to try again.
      throw new Error(`the render answered ${captured.status}`);
    }
  } catch (error) {
    stopHeartbeat();
    return { kind: 'failed', render: captured, error: await giveUp(input, lease, error, began) };
  }
  // What this isolate holds of the entry is the generation the render replaces. Let go of it with
  // the answer rather than with the commit, so that a request after the answer asks the host —
  // which says the same until the commit has landed, and the replacement from then on — however
  // long this isolate then takes to hear the commit answered.
  forgetRecord(runtime, lease.entryId);
  const published = publish(
    input,
    lease,
    { render: captured, observedTagRevision, began },
    stopHeartbeat,
  );
  input.waitUntil(published);
  return { kind: 'accepted', render: captured, published };
}

/**
 * Whether a visitor may be answered with what a render or a generation says, as it says it: never
 * a status a `Response` cannot carry — below 200 — nor a server error, which no generation is
 * published under, and never a redirect that does not say where it leads. That one would send the
 * visitor nowhere. A record can say either: one seeded by a deployment older than the Function
 * that reads it, or than the upload check that now holds a status to 200–599, does.
 */
export function servable(status: number, headers: Readonly<Record<string, string>>): boolean {
  if (status < HTTP_OK || status >= HTTP_SERVER_ERROR) {
    return false;
  }
  return !REDIRECT_STATUSES.has(status) || headers['location'] !== undefined;
}
