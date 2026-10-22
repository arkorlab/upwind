import {
  MAX_PACK_BYTES,
  packBytesAtMost,
  type RouteEntryKind,
  type RuntimeCacheControl,
  runtimeCacheControlFromHeader,
} from '@stayingupwind/core/cache';

import { initUrlOf } from '../incoming.ts';
import { readWithin } from './body.ts';
import { requestContext, type RequestContext } from './context.ts';

/**
 * What a static render produced, kept for the cache. An App Router page is taken off the
 * response cache entry Next.js hands the platform (`onCacheEntry`) rather than off the wire: the
 * document, the state that resumes it, its RSC payload and prefetch segments, the headers and
 * status it is served with, and the lifetime Next.js gave it; returning `true` to Next.js says
 * the platform answered the request itself, so the render is never written to the response. A
 * Pages Router page and a route handler have no such callback: their render is the response,
 * read whole, with the lifetime their `cache-control` states.
 */

const APP_PAGE = 'APP_PAGE';
/**
 * The most a render read off its response may come to: the largest body a delivery record can
 * carry with no state beside it, which is less than an artifact may hold as well. A body past it
 * could never be published, so it is not read past it.
 */
export const MAX_CAPTURED_BYTES = MAX_PACK_BYTES - packBytesAtMost(0, 0);
const NEXT_DATA_MARKER = 'id="__NEXT_DATA__"';
const SCRIPT_END = '</script>';
const HTTP_OK = 200;
const EMPTY_SEGMENTS: ReadonlyMap<string, Uint8Array> = new Map();

/** This diagnostic edition observes two existing branches; it changes no serving decision. */
const PHASE_PREFIX = '[upwind-phase-v4] ';
const PHASE_EDITION = 'capture-resume-context-v4';
const PHASE_BOUND = 4;
const PHASE_LINE_LIMIT = 512;
type PhasePresence = 'unobserved' | 'absent' | 'present';
type PhaseDisposition =
  | 'unobserved'
  | 'declined-nonpage'
  | 'declined-dynamic'
  | 'accepted'
  | 'ambiguous';
interface PhaseState {
  callbackCount: number;
  callbackDisposition: PhaseDisposition;
  capturePostponed: PhasePresence;
  terminalCount: number;
  attemptCount: number;
  invalid: boolean;
}
type PhaseFields =
  | {
      readonly event: 'capture-final';
      readonly terminal: 'uncaptured' | 'accepted-state-absent' | 'accepted-state-present';
      readonly terminalCount: number;
    }
  | {
      readonly event: 'resume-attempt';
      readonly resumePostponed: 'absent' | 'present';
      readonly attemptCount: number;
    };
const phases = new WeakMap<RequestContext, PhaseState>();
const phaseBudget = { emissions: 0, invalid: false };

function phaseState(): PhaseState | undefined {
  const context = requestContext();
  if (context === undefined) return undefined;
  const existing = phases.get(context);
  if (existing !== undefined) return existing;
  const { request } = context;
  if (
    request.method !== 'GET' ||
    request.headers.get('sec-fetch-dest') !== 'document' ||
    new URL(initUrlOf(request)).pathname !== '/page-params/1'
  )
    return undefined;
  const state: PhaseState = {
    callbackCount: 0,
    callbackDisposition: 'unobserved',
    capturePostponed: 'unobserved',
    terminalCount: 0,
    attemptCount: 0,
    invalid: false,
  };
  phases.set(context, state);
  return state;
}

function phaseFailed(state: PhaseState | undefined): void {
  phaseBudget.invalid = true;
  if (state !== undefined) state.invalid = true;
}

function emitPhase(state: PhaseState, fields: PhaseFields): void {
  if (phaseBudget.emissions >= PHASE_BOUND) {
    phaseFailed(state);
    return;
  }
  phaseBudget.emissions += 1;
  if (phaseBudget.emissions === PHASE_BOUND) phaseFailed(state);
  const record = {
    edition: PHASE_EDITION,
    ...fields,
    callbackCount: state.callbackCount,
    callbackDisposition: state.callbackDisposition,
    capturePostponed: state.capturePostponed,
    invalid: state.invalid || phaseBudget.invalid,
  };
  const line = PHASE_PREFIX + JSON.stringify(record);
  if (line.length > PHASE_LINE_LIMIT) {
    phaseFailed(state);
    return;
  }
  // Only fixed enums/counts. Delivery is not acknowledged; missing logs cannot prove a call was absent.
  // eslint-disable-next-line no-console
  console.log(line);
}

function noteCapture(disposition: PhaseDisposition, postponed: PhasePresence): void {
  let state: PhaseState | undefined;
  try {
    state = phaseState();
    if (state === undefined) return;
    state.callbackCount = Math.min(PHASE_BOUND, state.callbackCount + 1);
    const repeated = state.callbackCount !== 1;
    state.callbackDisposition = repeated ? 'ambiguous' : disposition;
    state.capturePostponed = repeated ? 'unobserved' : postponed;
    state.invalid ||= repeated;
  } catch {
    phaseFailed(state);
  }
}

function noteCaptureFinal(render: CapturedRender | undefined): void {
  let state: PhaseState | undefined;
  try {
    state = phaseState();
    if (state === undefined) return;
    state.terminalCount = Math.min(PHASE_BOUND, state.terminalCount + 1);
    state.invalid ||= state.terminalCount !== 1;
    let terminal: 'uncaptured' | 'accepted-state-absent' | 'accepted-state-present' = 'uncaptured';
    if (render !== undefined) {
      terminal =
        render.postponed === undefined ? 'accepted-state-absent' : 'accepted-state-present';
    }
    emitPhase(state, { event: 'capture-final', terminal, terminalCount: state.terminalCount });
  } catch {
    phaseFailed(state);
  }
}

/** An attempted call only: prior capture facts belong to this exact request context. */
export function noteResumeAttempt(requestMeta: Record<string, unknown>): void {
  let state: PhaseState | undefined;
  try {
    state = phaseState();
    if (state === undefined) return;
    state.attemptCount = Math.min(PHASE_BOUND, state.attemptCount + 1);
    state.invalid ||= state.attemptCount !== 1;
    emitPhase(state, {
      event: 'resume-attempt',
      resumePostponed: requestMeta['postponed'] === undefined ? 'absent' : 'present',
      attemptCount: state.attemptCount,
    });
  } catch {
    phaseFailed(state);
  }
}

/** The entry as `next/dist/server/response-cache` types it, reduced to what is read here. */
interface CacheEntryLike {
  readonly value:
    | {
        readonly kind: string;
        readonly html?: { toUnchunkedString(): string } | undefined;
        readonly rscData?: Uint8Array | undefined;
        readonly postponed?: string | undefined;
        readonly headers?: Record<string, string | string[] | number | undefined> | undefined;
        readonly status?: number | undefined;
        readonly segmentData?: ReadonlyMap<string, Uint8Array> | undefined;
      }
    | null
    | undefined;
  readonly cacheControl?:
    | { readonly revalidate: number | false; readonly expire?: number | undefined }
    | undefined;
}

export interface CapturedRender {
  readonly html: Uint8Array;
  readonly postponed: string | undefined;
  readonly rscData: Uint8Array | undefined;
  readonly segments: ReadonlyMap<string, Uint8Array>;
  readonly headers: Record<string, string>;
  readonly status: number;
  readonly cacheControl: RuntimeCacheControl;
  /** The props a Pages Router page was rendered with, as its data route serves them. */
  readonly data: Uint8Array | undefined;
  /** Supplementary Next metadata, never permission to publish shared HTML by itself. */
  readonly pagesStatic?:
    | {
        readonly page: string;
        readonly buildId: string;
        /** Supplementary path parameters, checked against immutable build authority before use. */
        readonly query?: Readonly<Record<string, string | readonly string[]>> | undefined;
      }
    | undefined;
}

type OnCacheEntry = (
  cacheEntry: CacheEntryLike,
  requestMeta: { url: string | undefined },
) => Promise<boolean> | boolean;

function headerText(value: string | string[] | number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return typeof value === 'string' ? value : value.join(', ');
}

function flatHeaders(
  headers: CacheEntryLike['value'] extends infer V
    ? V extends { headers?: infer H }
      ? H
      : never
    : never,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) {
    return out;
  }
  const entries = Object.entries(headers);
  for (const [name, value] of entries) {
    const text = headerText(value);
    if (text !== undefined) {
      out[name.toLowerCase()] = text;
    }
  }
  return out;
}

/**
 * A callback that keeps one render, if it is one worth keeping: an App Router page whose
 * lifetime allows it to be cached. Anything else — a dynamic render, another kind of entry — is
 * left to Next.js to answer, and `captured` stays empty.
 */
function captureCallback(): {
  readonly onCacheEntry: OnCacheEntry;
  captured(): CapturedRender | undefined;
} {
  let render: CapturedRender | undefined;
  const onCacheEntry: OnCacheEntry = (cacheEntry) => {
    const { value, cacheControl } = cacheEntry;
    if (value?.kind !== APP_PAGE || value.html === undefined) {
      noteCapture('declined-nonpage', 'unobserved');
      return false;
    }
    if (cacheControl === undefined || cacheControl.revalidate === 0) {
      noteCapture('declined-dynamic', 'unobserved');
      return false;
    }
    render = {
      html: new TextEncoder().encode(value.html.toUnchunkedString()),
      postponed: value.postponed,
      rscData: value.rscData,
      segments: value.segmentData === undefined ? new Map() : new Map(value.segmentData),
      headers: flatHeaders(value.headers),
      status: value.status ?? HTTP_OK,
      cacheControl: { revalidate: cacheControl.revalidate, expire: cacheControl.expire },
      data: undefined,
    };
    noteCapture('accepted', render.postponed === undefined ? 'absent' : 'present');
    return true;
  };
  return { onCacheEntry, captured: () => render };
}

/**
 * What a Pages Router page's data route serves, read off the document: `__NEXT_DATA__` carries
 * the props the page was rendered with, and the data route answers exactly those. One render,
 * one generation, its two outputs in agreement.
 */
function pageQuery(query: unknown): Record<string, string | readonly string[]> | undefined {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) return undefined;
  const parsed: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(query)) {
    if (
      typeof value !== 'string' &&
      (!Array.isArray(value) || value.some((part: unknown) => typeof part !== 'string'))
    )
      return undefined;
    Object.defineProperty(parsed, name, { value, enumerable: true });
  }
  return parsed;
}

function pagesStaticOf(value: Record<string, unknown>): CapturedRender['pagesStatic'] {
  if (
    value['gsp'] !== true ||
    ['gssp', 'gip', 'appGip', 'isPreview'].some(
      (name) => value[name] !== undefined && value[name] !== false,
    ) ||
    value['isFallback'] !== false ||
    value['err'] !== undefined ||
    typeof value['page'] !== 'string' ||
    typeof value['buildId'] !== 'string'
  )
    return undefined;
  const query = pageQuery(value['query']);
  return query === undefined
    ? undefined
    : {
        page: value['page'],
        buildId: value['buildId'],
        ...(Object.keys(query).length > 0 && { query }),
      };
}

function pagesDataOf(html: Uint8Array): Pick<CapturedRender, 'data' | 'pagesStatic'> {
  const text = new TextDecoder().decode(html);
  const marker = text.indexOf(NEXT_DATA_MARKER);
  if (marker === -1) {
    return { data: undefined };
  }
  const start = text.indexOf('>', marker);
  const end = start === -1 ? -1 : text.indexOf(SCRIPT_END, start);
  if (start === -1 || end === -1) {
    return { data: undefined };
  }
  try {
    const parsed: unknown = JSON.parse(text.slice(start + 1, end));
    if (typeof parsed !== 'object' || parsed === null || !('props' in parsed)) {
      return { data: undefined };
    }
    return {
      data: new TextEncoder().encode(JSON.stringify(parsed.props)),
      ...(!text.includes(NEXT_DATA_MARKER, marker + NEXT_DATA_MARKER.length) && {
        pagesStatic: pagesStaticOf(parsed),
      }),
    };
  } catch {
    return { data: undefined };
  }
}

/**
 * The lifetime a render's response states for the cache, from its `cache-control`; `undefined`
 * for one that is not to be kept, which is a render dynamic here.
 */
export function cacheLifetimeOf(response: Response): RuntimeCacheControl | undefined {
  const cacheControl = runtimeCacheControlFromHeader(response.headers.get('cache-control'));
  return cacheControl === undefined || cacheControl.revalidate === 0 ? undefined : cacheControl;
}

/**
 * A render kept off the response — a Pages Router page, a route handler — with the lifetime its
 * `cache-control` states. `undefined` for a response that is not to be cached. One no generation
 * could hold is read no further than it takes to know that, and fails the capture.
 */
async function captureResponse(response: Response): Promise<CapturedRender | undefined> {
  const cacheControl = cacheLifetimeOf(response);
  if (cacheControl === undefined) {
    await response.body?.cancel();
    return undefined;
  }
  const html =
    response.body === null ? new Uint8Array() : await readWithin(response.body, MAX_CAPTURED_BYTES);
  if (html === undefined) {
    throw new Error(`the render is larger than the ${MAX_CAPTURED_BYTES} bytes a generation holds`);
  }
  return {
    html,
    postponed: undefined,
    rscData: undefined,
    segments: EMPTY_SEGMENTS,
    headers: Object.fromEntries(response.headers),
    status: response.status,
    cacheControl,
    data: undefined,
  };
}

export interface CaptureMeta {
  /** What the request's metadata carries for the capture. */
  readonly requestMeta: Record<string, unknown>;
  /** Whether the handler answers through the callback rather than the response. */
  readonly expectNoResponse: boolean;
}

/**
 * Capture an App Router prerender, or keep the response Next.js wrote when it could not be
 * captured. A visitor can be answered with that dynamic response without rendering again.
 */
export async function renderAppPage(
  invoke: (meta: CaptureMeta) => Promise<Response>,
): Promise<CapturedRender | Response> {
  const capture = captureCallback();
  const response = await invoke({
    requestMeta: { onCacheEntry: capture.onCacheEntry, onCacheEntryV2: capture.onCacheEntry },
    expectNoResponse: true,
  });
  const render = capture.captured();
  noteCaptureFinal(render);
  if (render === undefined) {
    return response;
  }
  await response.body?.cancel();
  return render;
}

/**
 * Render through `invoke` and keep what a cache would: through Next.js's callback for an App
 * Router page, whose render is then never written to the response, and off the response for a
 * Pages Router page or a route handler.
 */
export async function renderCaptured(
  kind: RouteEntryKind,
  invoke: (meta: CaptureMeta) => Promise<Response>,
): Promise<CapturedRender | undefined> {
  if (kind === 'app-page') {
    const render = await renderAppPage(invoke);
    // A render that was answered rather than captured is dynamic; its body is not wanted.
    if (render instanceof Response) {
      await render.body?.cancel();
      return undefined;
    }
    return render;
  }
  const render = await captureResponse(await invoke({ requestMeta: {}, expectNoResponse: false }));
  if (render === undefined || kind === 'app-route') {
    return render;
  }
  return { ...render, ...pagesDataOf(render.html) };
}
