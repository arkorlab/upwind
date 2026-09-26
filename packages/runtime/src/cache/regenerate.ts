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
} from '@upwind/core/cache';
import { REDIRECT_STATUSES } from '@upwind/core/request';

import type { NodeHandler } from '../app-module.ts';
import { render404 } from '../error-pages.ts';
import { invokeNodeHandler, type Run } from '../node-bridge.ts';
import { type CapturedRender, renderCaptured } from './capture.ts';
import { nowMs } from './clock.ts';
import { asRegeneration } from './context.ts';
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

export type RegenerationOutcome =
  | { readonly kind: 'published'; readonly render: CapturedRender; readonly generationId: string }
  | { readonly kind: 'busy' }
  | { readonly kind: 'skipped'; readonly render: CapturedRender | undefined }
  | { readonly kind: 'refused'; readonly reason: string }
  | {
      readonly kind: 'failed';
      readonly render: CapturedRender | undefined;
      readonly error: string;
    };

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
  const [body, postponed, rsc, data] = await Promise.all([
    one(primary.role, render.html, primary.contentType),
    render.postponed === undefined
      ? undefined
      : one('postponed', encoder.encode(render.postponed), JSON_TYPE),
    render.rscData === undefined ? undefined : one('rsc', render.rscData, RSC_TYPE),
    render.data === undefined ? undefined : one(PAGES_DATA, render.data, JSON_UTF8_TYPE),
  ]);
  const segments = new Map<string, UploadedArtifact>();
  for (const [key, bytes] of render.segments) {
    segments.set(key, await one('segment', bytes, RSC_TYPE));
  }
  return { body, postponed, rsc, data, segments };
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

/** What the render came to: the outputs that were stored, and the tags it left on the entry. */
interface Made {
  readonly uploads: Uploads;
  readonly tags: readonly GenerationTag[];
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
    observedTagRevision: input.runtime.tags.revision,
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

type Leased = Extract<AttemptOutcome, { kind: 'leased' }>;

/** A third of what is left of the lease, and never so often that the beats are the work. */
const HEARTBEAT_DIVISOR = 3;
const MIN_HEARTBEAT_MS = 5000;

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
    // Handed to the runtime rather than left loose: the beat outlives no response, but it is a
    // request of its own and the isolate may not be torn down in the middle of it.
    input.waitUntil(beat());
  }, every);
  return () => {
    clearInterval(timer);
  };
}

/** Take the lease, render, upload and commit — or say why not. Never throws. */
export async function regenerate(input: RegenerationInput): Promise<RegenerationOutcome> {
  const { runtime, target } = input;
  // The view of the tags the render will judge its data-cache reads against, brought up to date
  // before the lease rather than on the first read, and whatever the hold says: the revision it
  // stands at is what the commit claims the render knew, and a claim older than the render is one
  // the host refuses the generation for. One delta pull beside the several calls a
  // regeneration already makes, and none of them on a request that is served.
  await runtime.tags.sync(runtime.host, nowMs(), { force: true });
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
  let captured: CapturedRender | undefined;
  const stopHeartbeat = heartbeat(input, lease);
  try {
    captured = await renderStatic(input, lease.attemptId);
    if (captured === undefined) {
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
    // Ahead of the uploads: a render the contract will not take is one whose outputs are not
    // worth sending, and what says so is `tagsOf`.
    const tags = tagsOf(target, captured);
    const uploads = await upload(input, lease, captured);
    const committed = await runtime.host.commit(
      lease.attemptId,
      commitRequest(input, lease, captured, { uploads, tags }),
    );
    if (committed.kind === 'published') {
      runtime.recordMemo.delete(lease.entryId);
      return { kind: 'published', render: captured, generationId: committed.generationId };
    }
    return { kind: 'refused', reason: committed.kind };
  } catch (error) {
    await abandon(input, lease, 'failed', error);
    runtime.log('regeneration failed', {
      pathname: target.descriptor.pathname,
      detail: detail(error),
    });
    return { kind: 'failed', render: captured, error: detail(error) };
  } finally {
    stopHeartbeat();
  }
}

/**
 * Whether a visitor may be answered with what a render or a generation says, as it says it: never
 * a status a `Response` cannot carry — below 200 — nor a server error, which no generation is
 * published under, and never a redirect that does not say where it leads. That one would send the
 * visitor nowhere. A record can say either: one seeded by a deployment older than the Worker
 * that reads it, or than the upload check that now holds a status to 200–599, does.
 */
export function servable(status: number, headers: Readonly<Record<string, string>>): boolean {
  if (status < HTTP_OK || status >= HTTP_SERVER_ERROR) {
    return false;
  }
  return !REDIRECT_STATUSES.has(status) || headers['location'] !== undefined;
}
