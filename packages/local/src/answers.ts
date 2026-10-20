import { kvGenerationKey } from '@stayingupwind/core/cache';
import {
  MIDDLEWARE_ONLY_HEADER,
  middlewareApplies,
  type MiddlewareResult,
} from '@stayingupwind/core/paas';
import { type CookieHostContext, rewriteSetCookieForPreview } from '@stayingupwind/core/request';
import { readMiddlewareAnswer } from '@stayingupwind/edge/handlers/responses';

import { read, type ReadOptions, type Reading } from './reading.ts';
import { edgeReads, middlewareReads, routedReads } from './routing-reads.ts';
import type { CspNonceSetting, LocalStack } from './stack.ts';
import {
  BACKSTAGE_ROUTES,
  type MiddlewareDecision,
  NONCE_PARAMS,
  type NoncedPolicies,
  type RecordedGeneration,
  type RecordedOutput,
  type Regeneration,
  TRACE_HEADER,
  TRACE_KEEP_PARAM,
} from './workers/protocol.ts';

/**
 * What the check's parts share (`check.ts`, `documents.ts`, `files.ts`): how a request is asked and
 * read, the verdict on it, and what the edge's own header says of how it answered.
 */

/** Where the edge says how it answered. */
export const EDGE_HEADER = 'x-arkor-edge';

export { edgeReads } from './routing-reads.ts';
/** What it says of a file of the build it served from storage. */
export const FROM_STORAGE = 'static;';
/**
 * What the edge's account of a document it composed begins with: anything else — a Function's
 * answer, a failure, any other path — is not the shell, as a deployment's validation holds it.
 */
export const SHELL_ANSWER = 'shell';
export const CLAIMED = 'claimed by a redirect or rewrite of next.config';
export const HTTP_OK = 200;
const REWRITE_HEADER = 'x-middleware-rewrite';
const SERVER_ERROR_MIN = 500;
/**
 * How long one answer may take, to its last byte. A document that never ends is a failure of its
 * own, and the check goes on to the next.
 */
const ANSWER_DEADLINE_MS = 30_000;
const MS_PER_SECOND = 1000;
const MIN_STATUS = 200;
const MAX_STATUS = 599;
const NOT_FOUND_STATUS = 404;
/**
 * What the edge says of an answer the application's middleware gave itself — a redirect, a
 * response, a rewrite it handed on — which a deployment's validation is not given, since it asks
 * past the middleware: the request is the middleware's to answer.
 */
const MIDDLEWARE_ANSWERED =
  /^passthrough;reason=(?:middleware|external-rewrite|rewritten|rewrite-not-proved)(?:;|$)/u;

/** The scheme a deployment's validation says it asks by: HTTPS, as a site is reached deployed. */
const FORWARDED_PROTO = 'https';

/**
 * A request under the site's origin, as a deployment's validation sends one: the `Host` its URL
 * names, and the forwarding headers beside it — HTTPS, whatever scheme reaches the stack, which a
 * rule of `next.config` may ask of. A Function that judges the host it is asked under — an allowed
 * origin, a redirect it builds — sees the one a visitor's request reaches it under, as the stack
 * addresses what it forwards (`workers/edge.ts`).
 */
export function forwarded(
  site: URL,
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...headers,
    host: site.host,
    'x-forwarded-host': site.host,
    'x-forwarded-proto': FORWARDED_PROTO,
  };
}

/** How a request was answered: as deployed, not, or by what the check does not judge. */
export type Verdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'skipped'; readonly reason: string };

const OK: Verdict = { kind: 'ok' };

export function failed(reason: string | undefined): Verdict {
  return reason === undefined ? OK : { kind: 'failed', reason };
}

export function skipped(reason: string): Verdict {
  return { kind: 'skipped', reason };
}

/** The answer, or why there was none. */
export async function answerTo(
  url: URL,
  options: Omit<ReadOptions, 'deadlineMs'>,
): Promise<Reading | string> {
  try {
    return await read(url, { ...options, deadlineMs: ANSWER_DEADLINE_MS });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `not answered whole within ${ANSWER_DEADLINE_MS / MS_PER_SECOND} s: ${detail}`;
  }
}

/**
 * A stack as the check asks it: reached at its own socket (`url`), and named in every request as a
 * deployment's validation names the site it asks (`site`) — the stack's own origin, or the
 * hostname a host's validation asks a candidate under (`CheckOptions.hostname`) — so that a rule or
 * a middleware that judges the host is judged on the one validation sends.
 */
export interface CheckedStack extends LocalStack {
  readonly site: URL;
  /** A response's own trace snapshot, retained after that trace is released. */
  readonly generationEvidence?: ReadonlyMap<string, RecordedGeneration> | undefined;
}

type GenerationStack = LocalStack & Pick<CheckedStack, 'generationEvidence'>;

/**
 * The domain the stack's edge shares with other sites, as a standalone edge has it
 * (`standaloneHost`): none, as it serves one site — `invalid`, under which no hostname a request
 * comes in on lies (RFC 6761).
 */
const NO_SHARED_DOMAIN = 'invalid';
const SET_COOKIE = 'set-cookie';

/**
 * How the stack's edge scopes a cookie it sends, as it scopes one (`forwardingFor`): to the hostname
 * a request names — the one every request of the check names the site by (`site`) — under no domain
 * shared with another site. A `Domain` that hostname is not in is taken off; one it is in is kept.
 */
export function cookieScopeOf(stack: CheckedStack): CookieHostContext {
  return { previewHost: stack.site.hostname, previewDomain: NO_SHARED_DOMAIN };
}

/**
 * A header a rule of `next.config` names, or a page was recorded with, as the stack's edge sets it on
 * what it serves from storage — a part, a file (`setConfigured`): a `Set-Cookie` scoped as the edge
 * scopes every cookie it sends (`scope`, `cookieScopeOf`), anything else as written.
 */
export function configuredValue(name: string, value: string, scope: CookieHostContext): string {
  return name.toLowerCase() === SET_COOKIE ? rewriteSetCookieForPreview(value, scope) : value;
}

/**
 * Why an answer the edge says the application's middleware ran on (`mw=hit`) is judged no further
 * where the stack kept nothing of what it decided: what the middleware set on it, and where it took
 * it, are the verdict's to know, and no guess stands in for them.
 */
const UNKEPT =
  "the edge says the application's middleware ran on it, and the stack kept nothing of what it decided";
/**
 * Why an answer fails where the stack kept what the application's middleware decided for it and the
 * edge says it did not run: an answer that dropped what the middleware set drops the word of it as
 * readily, and a check that believed the edge would never ask for what it dropped.
 */
const UNSAID =
  "the stack kept what the application's middleware decided for it, and the edge says it did not run";
/**
 * Why an answer the edge gave from what the deployment holds fails, where the application's
 * middleware covers the request and the edge says it did not run: what the middleware would have
 * set — a cookie, a redirect to a login page — goes unasked for by a check that believed the edge.
 */
const UNRUN = "the application's middleware covers it, and the edge says it did not run";
/**
 * Why an answer the edge gave from what the deployment holds fails, where the application's
 * middleware answered the request itself — a redirect, its own response, a rewrite to another
 * origin — which is the answer, and what the deployment holds is not (`MIDDLEWARE_ANSWERED`).
 */
const OVERRIDDEN =
  "the application's middleware answered it itself, and the edge served what the deployment holds in its place";

/**
 * Whether the edge's account of an answer says whether the middleware ran: one it gave from what the
 * deployment holds always does — a shell's says `mw=hit` or `mw=miss`, a file's `mw=hit` where it
 * ran — and one it handed on to the Function never does, whatever ran ahead of it.
 */
function saysOfMiddleware(answer: Reading): boolean {
  const answered = answeredBy(answer);
  return answered.startsWith(SHELL_ANSWER) || answered.startsWith(FROM_STORAGE);
}

/**
 * Why what the stack kept of a traced request disagrees with what the edge says of it (`mw=hit`): it
 * says the middleware ran, and the stack kept nothing of what it decided (`UNKEPT`), or it served
 * what the deployment holds where the middleware answered the request itself (`OVERRIDDEN`); or it
 * says the middleware did not run — where it says anything of it (`saysOfMiddleware`) — and the
 * stack kept a decision (`UNSAID`), or the build's matchers cover the request (`covered`, `UNRUN`).
 * None where they agree.
 */
export function keptFailure(
  answer: Reading,
  decided: MiddlewareResult | undefined,
  covered = false,
): string | undefined {
  if (middlewareRan(answer)) {
    if (decided === undefined) {
      return UNKEPT;
    }
    // Served from what the deployment holds, it has to be what the middleware let through.
    return decided.kind !== 'continue' && saysOfMiddleware(answer) ? OVERRIDDEN : undefined;
  }
  if (!saysOfMiddleware(answer)) {
    return undefined;
  }
  if (decided !== undefined) {
    return UNSAID;
  }
  return covered ? UNRUN : undefined;
}

/**
 * Why an answer that says nothing of the middleware fails all the same (`saysOfMiddleware`): one the
 * edge gives only behind the middleware — a page it regenerated in the foreground, a `HEAD` it hands
 * on — where the build's matchers cover the request (`covered`) and the stack kept nothing of what
 * it decided, so it did not run: what it would have set — a cookie, a redirect to a login page —
 * goes unasked for. `done` is what the edge did instead, in a verdict's words.
 */
export function unrunFailure(
  decided: MiddlewareResult | undefined,
  covered: boolean,
  done: string,
): string | undefined {
  return covered && decided === undefined
    ? `the application's middleware covers it, and the edge ${done} without running the middleware`
    : undefined;
}

/**
 * Whether the application's middleware covers a request, by what the build says of it — its
 * matchers (`bundle.middleware`), not the manifest under check, and the Function the stack runs it
 * in — as the edge decides it (`middlewareApplies`).
 */
export function middlewareCovers(
  stack: LocalStack,
  url: URL,
  headers: Readonly<Record<string, string>>,
): boolean {
  const matchers = stack.bundle.middleware?.matchers;
  return (
    matchers !== undefined &&
    stack.app.middlewareScriptName !== undefined &&
    middlewareApplies(matchers, url, middlewareReads(stack.manifest, url, headers))
  );
}

/** What the edge said of how it answered. */
export function answeredBy(answer: Pick<Reading, 'headers'>): string {
  return String(answer.headers[EDGE_HEADER] ?? '');
}

/**
 * Why an answer the edge served from what the deployment holds — a shell, a file — does not say it
 * served it under the stack's delivery policy (`policy=`), as a deployment's validation asks of a
 * candidate's answers: what passes is then what the policy it goes live under serves.
 */
export function policyFailure(stack: LocalStack, answer: Reading): string | undefined {
  const { id } = stack.policy;
  const answered = answeredBy(answer);
  return answered.split(';').includes(`policy=${id}`)
    ? undefined
    : `not answered under the delivery policy ${id} (${EDGE_HEADER}: ${answered})`;
}

/** Whether the application's middleware answered the request itself, and what the edge said. */
export function middlewareAnswered(answer: Pick<Reading, 'headers'>): string | undefined {
  const answered = answeredBy(answer);
  return MIDDLEWARE_ANSWERED.test(answered)
    ? `answered by the application's middleware (${answered})`
    : undefined;
}

/** The same ownership test at response headers, before a direct document's body is read. */
export function middlewareHeadersOnly(_status: number, headers: Reading['headers']): boolean {
  return middlewareAnswered({ headers }) !== undefined;
}

/**
 * Whether the application's middleware ran on the request and let it through (`mw=hit`): what is
 * served after it is the middleware's to shape — rewritten onto another page or file, recast, made
 * private — so an answer that is not the build's, byte for byte, may be the middleware's doing.
 */
export function middlewareRan(answer: Reading): boolean {
  return answeredBy(answer).split(';').includes('mw=hit');
}

/**
 * Whether a body is undone of its codings as it streams (`ReadOptions.decode`): where it is asked
 * for in one (`coded`), but for an answer from storage, kept as it was stored — a precompressed
 * file's bytes are its coded ones, which is how the edge holds and serves the file.
 */
export function undoneUnlessStored(
  coded: boolean,
): boolean | ((headers: Readonly<Record<string, string | string[] | undefined>>) => boolean) {
  return coded && ((headers) => !String(headers[EDGE_HEADER] ?? '').startsWith(FROM_STORAGE));
}

/** A failure's status: a server error's. */
export function failureStatus(answer: Reading): string | undefined {
  return answer.status >= SERVER_ERROR_MIN ? `answered ${answer.status}` : undefined;
}

/** Where the stack keeps what the edge did for the request traced under `trace`. */
function traceAt(stack: LocalStack, trace: string): URL {
  return new URL(`.${BACKSTAGE_ROUTES.trace}${encodeURIComponent(trace)}`, stack.backstage);
}

/**
 * Headers for a request the stack keeps what the edge did for, and the id it keeps it under — which
 * the stack is told to let go of once the request is judged (`await using`), read or not.
 */
export interface Traced extends AsyncDisposable {
  readonly headers: Readonly<Record<string, string>>;
  readonly trace: string;
}

/**
 * Rejects as the stack's own failure (`checkStack`), its backstage's answer let go of first rather
 * than left open behind the throw.
 */
async function backstageFailure(response: Response, message: string): Promise<never> {
  await response.body?.cancel();
  throw new Error(message);
}

/**
 * What the stack kept under `trace` let go of: a request judged without it — one the middleware
 * answered, say — leaves it unread, which the stack would keep until it is full.
 */
async function letGo(stack: LocalStack, trace: string): Promise<void> {
  try {
    const response = await fetch(traceAt(stack, trace), { method: 'DELETE' });
    await response.body?.cancel();
  } catch {
    // A stack that cannot be told keeps it until it is full: what the check made of the request,
    // or why it could not, stands.
  }
}

/**
 * `headers`, carrying an id the stack keeps what the edge did for the request under — one
 * registered with the stack first, which traces a request under no other, and let go of when the
 * request is judged (`Traced`).
 */
export async function traced(
  stack: LocalStack,
  headers: Readonly<Record<string, string>>,
): Promise<Traced> {
  const trace = crypto.randomUUID();
  const at = traceAt(stack, trace);
  // A value of its own under the name, which the request goes on with once the stack takes the id.
  const own = headers[TRACE_HEADER];
  if (own !== undefined) {
    at.searchParams.set(TRACE_KEEP_PARAM, own);
  }
  const registered = await fetch(at, { method: 'PUT' });
  if (!registered.ok) {
    await backstageFailure(registered, `the stack would not trace a request: ${registered.status}`);
  }
  return {
    headers: { ...headers, [TRACE_HEADER]: trace },
    trace,
    [Symbol.asyncDispose]: () => letGo(stack, trace),
  };
}

function isDecision(value: unknown): value is MiddlewareDecision {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { status, headers } = value as Record<string, unknown>;
  return (
    typeof status === 'number' &&
    status >= MIN_STATUS &&
    status <= MAX_STATUS &&
    Array.isArray(headers) &&
    headers.every((header) => {
      return (
        Array.isArray(header) &&
        header.length === 2 &&
        header.every((part) => typeof part === 'string')
      );
    })
  );
}

function isRegeneration(value: unknown): value is Regeneration {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { entry, route, member } = value as Record<string, unknown>;
  return typeof entry === 'string' && typeof route === 'string' && typeof member === 'boolean';
}

/** The JSON the backstage answered with about `what`, or why the check cannot go on without it. */
async function jsonOf(response: Response, what: string): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error(`the stack's backstage kept ${what} as other than JSON`);
  }
}

/** A captured middleware answer, including the status the edge keeps for an internal rewrite. */
export type KeptMiddlewareResult = MiddlewareResult & {
  readonly rewriteStatus?: number | undefined;
};

/** What the stack kept of a traced request, as the check reads it. */
export interface Kept {
  /**
   * What the application's middleware decided, as the edge ran it and read it
   * (`readMiddlewareAnswer`): none where it did not run, or the stack kept nothing of it.
   */
  readonly decided: KeptMiddlewareResult | undefined;
  /** The record the edge had a Function regenerate in front of the request, where it did. */
  readonly regenerated: Regeneration | undefined;
  readonly generations?: ReadonlyMap<string, RecordedGeneration> | undefined;
}

/** Use this response's captured reads, falling back to the old backstage only for old replies. */
export function withGenerationEvidence(stack: CheckedStack, kept: Kept): CheckedStack {
  if (kept.generations === undefined && stack.generationEvidence === undefined) return stack;
  return { ...stack, generationEvidence: kept.generations };
}

/**
 * What the edge did for a traced request that its answer does not say, asked of `url` with
 * `headers`, read once: the middleware's own answer, which no client is sent and running the
 * middleware again could decide otherwise, and the record the edge had regenerated in front of it.
 */
export async function keptOf(
  stack: LocalStack,
  trace: string,
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<Kept> {
  const response = await fetch(traceAt(stack, trace));
  if (response.status === NOT_FOUND_STATUS) {
    await backstageFailure(
      response,
      'the stack let go of what it kept of a traced request before the check read it',
    );
  }
  if (!response.ok) {
    await backstageFailure(
      response,
      `the stack's backstage answered ${response.status} for what it kept of a traced request`,
    );
  }
  const record = await jsonOf(response, 'a traced request');
  const { decision, regenerated, generations } =
    typeof record === 'object' && record !== null
      ? (record as Record<string, unknown>)
      : { decision: undefined, regenerated: undefined, generations: undefined };
  const kept = {
    decided: undefined,
    regenerated: isRegeneration(regenerated) ? regenerated : undefined,
    generations: capturedGenerations(generations),
  };
  if (!isDecision(decision)) {
    return kept;
  }
  const answeredWith = new Headers();
  for (const [name, value] of decision.headers) {
    answeredWith.append(name, value);
  }
  const answered = new Response(null, { status: decision.status, headers: answeredWith });
  const client = edgeReads(headers);
  const handed = routedReads(url, headers);
  handed.set(MIDDLEWARE_ONLY_HEADER, '1');
  const decided = readMiddlewareAnswer(answered, url, client, handed);
  return {
    ...kept,
    decided:
      decided.kind === 'continue' &&
      answered.status !== HTTP_OK &&
      answered.headers.has(REWRITE_HEADER)
        ? { ...decided, rewriteStatus: answered.status }
        : decided,
  };
}

/** A generation of a route's record: the scope and the entry it is kept under, and its sequence. */
export interface Generation {
  readonly scopeId: string;
  readonly entryId: string;
  readonly seq: number;
}

function isHeaders(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((header) => typeof header === 'string')
  );
}

/**
 * The headers `generation` was recorded with, as the stack's edge read it (`workers/edge.ts`): what
 * the edge sends a document served from it with. None where the edge never read it.
 */
export async function recordedHeadersOf(
  stack: GenerationStack,
  generation: Generation,
): Promise<Readonly<Record<string, string>> | undefined> {
  if (stack.generationEvidence !== undefined) {
    const key = kvGenerationKey(generation.scopeId, generation.entryId);
    return stack.generationEvidence.get(`${key}|${generation.seq}`)?.headers;
  }
  const at = [generation.scopeId, generation.entryId, String(generation.seq)]
    .map((part) => encodeURIComponent(part))
    .join('/');
  const response = await fetch(new URL(`.${BACKSTAGE_ROUTES.generation}${at}`, stack.backstage));
  if (!response.ok) {
    await backstageFailure(
      response,
      `the stack's backstage answered ${response.status} for the headers of a generation`,
    );
  }
  const headers = await jsonOf(response, "a generation's headers");
  return isHeaders(headers) ? headers : undefined;
}

/** Whether `value` is an output of a generation, as the backstage names one (`RecordedOutput`). */
function isRecordedOutput(value: unknown): value is RecordedOutput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const output = value as Record<string, unknown>;
  return (
    ['role', 'representationKey', 'encoding', 'sha256'].every(
      (field) => typeof output[field] === 'string',
    ) && typeof output['byteLength'] === 'number'
  );
}

/** Whether `value` is a generation as the backstage names one (`RecordedGeneration`). */
function isRecordedGeneration(value: unknown): value is RecordedGeneration {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { headers, artifacts, partial, source, freshness } = value as Record<string, unknown>;
  return (
    isHeaders(headers) &&
    Array.isArray(artifacts) &&
    artifacts.every(isRecordedOutput) &&
    typeof partial === 'boolean' &&
    typeof source === 'string' &&
    (freshness === undefined || (typeof freshness === 'object' && freshness !== null))
  );
}

/** Optional metadata added to the existing trace reply; old backstage replies still work. */
function capturedGenerations(value: unknown): ReadonlyMap<string, RecordedGeneration> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return new Map(
    Object.entries(value).flatMap(([key, generation]) => {
      const entry = isRecordedGeneration(generation) ? [[key, generation] as const] : [];
      return entry;
    }),
  );
}

/**
 * Each generation of a record the stack's edge read, by sequence (`workers/edge.ts`): the headers it
 * was recorded with and the outputs it holds — what the edge serves a part from one of them with.
 */
export async function recordedGenerationsOf(
  stack: GenerationStack,
  record: Omit<Generation, 'seq'>,
): Promise<ReadonlyMap<number, RecordedGeneration>> {
  if (stack.generationEvidence !== undefined) {
    const prefix = `${kvGenerationKey(record.scopeId, record.entryId)}|`;
    return new Map(
      [...stack.generationEvidence].flatMap(([key, generation]) => {
        const entry = key.startsWith(prefix)
          ? [[Number(key.slice(prefix.length)), generation] as const]
          : [];
        return entry;
      }),
    );
  }
  const at = [record.scopeId, record.entryId].map((part) => encodeURIComponent(part)).join('/');
  const response = await fetch(new URL(`.${BACKSTAGE_ROUTES.generation}${at}`, stack.backstage));
  if (!response.ok) {
    await backstageFailure(
      response,
      `the stack's backstage answered ${response.status} for the generations of a record`,
    );
  }
  const listed = await jsonOf(response, "a record's generations");
  const kept = typeof listed === 'object' && listed !== null ? Object.entries(listed) : [];
  return new Map(
    kept.flatMap(([seq, generation]) => {
      return isRecordedGeneration(generation) && /^\d+$/u.test(seq)
        ? [[Number(seq), generation] as const]
        : [];
    }),
  );
}

/**
 * `shell` with `nonce` stamped in it as the stack's edge stamps a document it composes, by the
 * edge's own code (`BACKSTAGE_ROUTES.stamp`).
 */
export async function stampedOf(
  stack: LocalStack,
  shell: Uint8Array,
  nonce: string,
): Promise<Buffer> {
  const asked = new URLSearchParams({ [NONCE_PARAMS.nonce]: nonce });
  const response = await fetch(new URL(`.${BACKSTAGE_ROUTES.stamp}?${asked}`, stack.backstage), {
    method: 'POST',
    body: Uint8Array.from(shell),
  });
  if (!response.ok) {
    await backstageFailure(
      response,
      `the stack's backstage answered ${response.status} for a shell to stamp`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * `policies` with `nonce` put in them as the stack's edge puts it under `setting`, by the edge's own
 * code (`BACKSTAGE_ROUTES.nonced`).
 */
export async function noncedPoliciesOf(
  stack: LocalStack,
  policies: NoncedPolicies,
  minted: { readonly nonce: string; readonly setting: CspNonceSetting },
): Promise<NoncedPolicies> {
  const { nonce, setting } = minted;
  const asked = new URLSearchParams({
    [NONCE_PARAMS.nonce]: nonce,
    [NONCE_PARAMS.mode]: setting.mode,
    ...(setting.strictDynamic && { [NONCE_PARAMS.strict]: '1' }),
  });
  const response = await fetch(new URL(`.${BACKSTAGE_ROUTES.nonced}?${asked}`, stack.backstage), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(policies),
  });
  if (!response.ok) {
    await backstageFailure(
      response,
      `the stack's backstage answered ${response.status} for policies to put a nonce in`,
    );
  }
  const put = await jsonOf(response, 'policies with a nonce put in them');
  if (!isHeaders(put)) {
    throw new Error("the stack's backstage put a nonce in policies, and answered other than them");
  }
  return put;
}

/** Why an answer does not carry each of `cookies` as it was set, beside whatever else it sets. */
export function cookiesSetFailure(answer: Reading, cookies: readonly string[]): string | undefined {
  const sent = answer.headers['set-cookie'] ?? [];
  const unsent = cookies.find((cookie) => !sent.includes(cookie));
  return unsent === undefined
    ? undefined
    : `answered without the cookie ${unsent} the application set`;
}

/**
 * Why an answer does not carry the cookies the application set, each as it set it, and no other
 * (`Set-Cookie`, one header a cookie): the middleware's, a rule's, what the route was recorded with.
 */
export function cookieFailure(answer: Reading, cookies: readonly string[]): string | undefined {
  const sent = [...(answer.headers['set-cookie'] ?? [])];
  for (const cookie of cookies) {
    const at = sent.indexOf(cookie);
    if (at === -1) {
      return `answered without the cookie ${cookie} the application set`;
    }
    sent.splice(at, 1);
  }
  const [unset] = sent;
  return unset === undefined
    ? undefined
    : `answered with the cookie ${unset}, which the application did not set`;
}
