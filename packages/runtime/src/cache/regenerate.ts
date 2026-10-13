import {
  appPathFor,
  type DecodedGenerationPack,
  generationResponseHeaders,
  type GenerationTag,
  implicitTagsFor,
  parseCacheTagsHeader,
  policyFromCacheControl,
  type RouteEntryDescriptor,
  tagKindOf,
} from '@stayingupwind/core/cache';

import type { NodeHandler } from '../app-module.ts';
import { render404 } from '../error-pages.ts';
import { invokeNodeHandler, type Run } from '../node-bridge.ts';
import { type CapturedRender, renderCaptured } from './capture.ts';
import { nowMs } from './clock.ts';
import { asRegeneration } from './context.ts';
import { forgetRecord, forgetRecordBefore, publishedRecordOf, rememberRecord } from './current.ts';
import {
  type AttemptOutcome,
  type AttemptReason,
  CacheHostError,
  type CommitArtifact,
  type CommitOutput,
  type CommitRequest,
  type CurrentSummary,
  type ServedObservation,
  type UploadedArtifact,
} from './host.ts';
import {
  abandon,
  elapsedSince,
  giveUp,
  heartbeat,
  type Leased,
  RegenerationError,
  supersededBy,
  within,
} from './lease.ts';
import {
  answeringAtOnce,
  answeringUntilSettled,
  answeringWhenSuperseded,
  answeringWhileBusy,
  publishingKeyOf,
} from './publishing.ts';
import type { CacheRuntime } from './runtime.ts';
import { servable } from './servable.ts';
import { refusedTags } from './tag-bounds.ts';
import { uploaderFor } from './uploads.ts';

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
 * says, and a visitor answered from a render made for them no longer waits for any of them before
 * the first byte, as it once waited for every one. Until they have settled, the render answers the
 * isolate's other requests that would regenerate the entry, as the lease it holds turns them away
 * (`cache/publishing.ts`): they are answered with the page the requests after the publish are,
 * rather than each with a page of its own.
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
  /**
   * The parameters the render is handed in its query, as routing hands them to a render of a
   * visitor's request, where Next.js would read them otherwise off the pathname
   * (`routingParameters`); none by default.
   */
  readonly parameters?: Readonly<Record<string, string>> | undefined;
  /**
   * The generation the request judged and would replace — `null` for an entry it found none of —
   * where it judged one (`supersededBy`); absent where it did not say.
   */
  readonly replaces?: string | null | undefined;
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
  | {
      readonly kind: 'busy';
      /**
       * The render this isolate is publishing of the entry, which holds the lease, as its
       * generation answers (`Publishing`): what a visitor is answered with rather than a page of
       * their own. Absent where the lease is another isolate's, or this one's render is not one to
       * answer with now.
       */
      readonly publishing?: CapturedRender | undefined;
      /** That render's publish, where there is one: never rejects (`Publishing.published`). */
      readonly published?: Promise<unknown> | undefined;
    }
  /**
   * The host holds a later generation than the one judged, which may be served (`supersededBy`);
   * with the render of it this isolate published, where it is the one (`answeringWhenSuperseded`).
   */
  | { readonly kind: 'superseded'; readonly publishing?: CapturedRender | undefined }
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

/**
 * The URL a static render is handed: the entry's pathname, with the parameters routing would name
 * in its query where there are any (`RegenerationTarget.parameters`).
 */
function staticUrl(target: RegenerationTarget): string {
  const { descriptor, parameters } = target;
  return parameters === undefined
    ? descriptor.pathname
    : `${descriptor.pathname}?${new URLSearchParams(parameters).toString()}`;
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
      url: staticUrl(input.target),
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

/** Every tag the render leaves on the entry: the ones it recorded, and the route's implicit ones. */
function tagValuesOf(target: RegenerationTarget, render: CapturedRender): Set<string> {
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
  return values;
}

/**
 * The tags the render leaves on the entry, as the commit names them (`tagValuesOf`).
 *
 * Refused here rather than at the gateway where a generation may not carry them (`refusedTags`): a
 * request past the contract's bounds is turned away by a schema whose message says nothing about
 * tags — so the entry would go on failing every regeneration with no way to read why. Said here,
 * before the outputs are uploaded, the attempt carries what was wrong and the pathname into the
 * inspector.
 */
function tagsOf(target: RegenerationTarget, render: CapturedRender): GenerationTag[] {
  const values = [...tagValuesOf(target, render)];
  const refused = refusedTags(values);
  if (refused !== undefined) {
    throw new RegenerationError(`the render of ${target.descriptor.pathname} ${refused.message}`, {
      code: refused.code,
    });
  }
  return values.map((value) => ({ kind: tagKindOf(value), value }));
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
  const uploads = uploaderFor(input.runtime.host, lease);
  const encoder = new TextEncoder();
  const primary = bodyArtifact(input.target, render);
  // The outputs together, the segments with the rest: the small ones in one call, sent once every
  // output has been handed over, and the rest each in its turn. One after another, a page's
  // segments were a round trip each between the render and its commit.
  const sent = Promise.all([
    uploads.send(primary.role, render.html, primary.contentType),
    render.postponed === undefined
      ? undefined
      : uploads.send('postponed', encoder.encode(render.postponed), JSON_TYPE),
    render.rscData === undefined ? undefined : uploads.send('rsc', render.rscData, RSC_TYPE),
    render.data === undefined ? undefined : uploads.send(PAGES_DATA, render.data, JSON_UTF8_TYPE),
    Promise.all(
      [...render.segments].map(
        async ([key, bytes]) => [key, await uploads.send('segment', bytes, RSC_TYPE)] as const,
      ),
    ),
  ]);
  const [[body, postponed, rsc, data, segments]] = await Promise.all([sent, uploads.flush()]);
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

/**
 * The headers the generation a render publishes is recorded with (`generationResponseHeaders`),
 * which every answer from it carries, whether from the render itself while it is being published
 * (`Publishing`) or from the generation once it is.
 */
function generationHeadersOf(
  target: RegenerationTarget,
  render: CapturedRender,
): Record<string, string> {
  return generationResponseHeaders(
    target.descriptor.kind,
    render.status,
    Object.entries(render.headers),
  );
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
      headers: generationHeadersOf(input.target, render),
      // Handed in rather than read here, because `tagsOf` ran before the uploads did: a render
      // carrying more tags than a generation may is refused without paying to store its outputs.
      tags: [...made.tags],
      outputs: outputsOf(input.target, render, made.uploads),
      reason: input.target.reason,
    },
  };
}

/**
 * How long a regeneration that holds its lease waits for the tags to be synced before it gives the
 * lease back. The pull pages through the scope's delta, which a fresh isolate reads from the
 * start; past this it is taken for lost — the request that began it may have ended under it, and
 * what a request left out never settles once it has — and the attempt ends as failed rather than
 * holding its lease, renewed by its heartbeat, for as long as the request lives.
 */
const TAG_SYNC_DEADLINE_MS = 10_000;

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
  let published: DecodedGenerationPack | undefined;
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
      published = await publishedRecordOf(committed.record, lease.entryId, committed.generationId);
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
    // Published with its record handed back, that record is what this isolate holds of the entry
    // from now: a read would ask a host that may answer with the generation it replaced for as long
    // as its own cache keeps it.
    if (published === undefined) {
      forgetRecord(runtime, lease.entryId);
    } else {
      rememberRecord(runtime, lease.entryId, published);
    }
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
  // This isolate's own regeneration of the entry, its render made and its publish out, holds the
  // lease: the host would turn this one away. Its render answers instead of a page of the visitor's
  // own — the page every request after the publish is answered with — while the view of the tags
  // says nothing it missed: at once within a hold of the view it read against, and past that once
  // the host has said the lease stands and the view has been brought up (`cache/publishing.ts`).
  const entryId = await publishingKeyOf(runtime, target.descriptor);
  // Read before the lease is asked for: the publish may settle, and let go of it, while the host
  // answers the lease.
  const kept = entryId === undefined ? undefined : runtime.publishing.get(entryId);
  const atOnce = answeringAtOnce(runtime, target.reason, entryId);
  if (atOnce !== undefined) {
    return { kind: 'busy', publishing: atOnce.render, published: atOnce.published };
  }
  // The view of the tags the render will judge its data-cache reads against, brought up to date
  // whatever the hold says: the revision it stands at is what the commit claims the render knew,
  // and a claim older than the render is one the host refuses the generation for. Pulled beside
  // the lease rather than ahead of it, since neither needs the other and a fresh isolate's pull
  // pages through the scope's whole delta — but finished before the render begins, which is what
  // keeps the claim true: the commit claims the revision the view stood at when the render began,
  // and every read the render makes is judged against that view or one brought further along
  // since. Handed to the runtime as well, whatever the lease says: a pull cut off with its request
  // would be the one every later sync of this isolate joins for a hold (`TagState.sync`).
  const askedAt = nowMs();
  const synced = runtime.tags.sync(runtime.host, askedAt, { force: true });
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
    return answeringWhileBusy(
      runtime,
      {
        reason: target.reason,
        entryId,
        holder: lease.attemptId,
        holderUntil: lease.leaseExpiresAt,
      },
      synced,
    );
  }
  // A render this isolate still keeps of the entry let go of its lease, as this one could not have
  // been taken otherwise: its commit is refused, or it has landed and its answer is on its way. It
  // answers nothing more, unless the generation the host holds is the one it became (below).
  runtime.publishing.delete(entryId ?? lease.entryId);
  if (supersededBy(target, lease.current, nowMs()) && answerable(lease.current)) {
    // Given back behind the answer, which waits for nothing of it: nobody holds the lease now.
    input.waitUntil(abandon(input, lease, 'skipped'));
    // What stands is what the next request should find: a record of it, or of a later one, that
    // another request of this isolate learned while this one waited for the lease stays held.
    forgetRecordBefore(runtime, lease.entryId, lease.current?.seq ?? Infinity);
    const ours = await answeringWhenSuperseded(kept, lease.current);
    return ours === undefined ? { kind: 'superseded' } : { kind: 'superseded', publishing: ours };
  }
  const began = performance.now();
  const stopHeartbeat = heartbeat(input, lease);
  let observedTagRevision: number;
  let viewed: boolean;
  let captured: CapturedRender | undefined;
  try {
    viewed = await within(synced, TAG_SYNC_DEADLINE_MS, {
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
  const publishing = publish(
    input,
    lease,
    { render: captured, observedTagRevision, began },
    stopHeartbeat,
  );
  // Kept to answer for the entry only where its own pull answered. One that did not was rendered
  // against a view older than the moment it asked for one, which its answers would be judged from.
  const published = viewed
    ? answeringUntilSettled(
        runtime,
        entryId ?? lease.entryId,
        {
          render: { ...captured, headers: generationHeadersOf(target, captured) },
          attemptId: lease.attemptId,
          tags: [...tagValuesOf(target, captured)],
          observedTagRevision,
          observedAt: askedAt,
          published: publishing,
        },
        publishing,
      )
    : publishing;
  input.waitUntil(published);
  return { kind: 'accepted', render: captured, published };
}

/**
 * Whether a visitor may be answered with the generation a lease says stands (`servable`): one whose
 * status the host did not say is not taken to be, so that a regeneration is never given up for a
 * generation that answers no visitor — a redirect that says not where to, say.
 */
function answerable(current: CurrentSummary | null | undefined): boolean {
  if (current?.status === undefined) {
    return false;
  }
  const location = current.location ?? undefined;
  return servable(current.status, location === undefined ? {} : { location });
}
