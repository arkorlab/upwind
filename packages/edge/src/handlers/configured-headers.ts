import type { ConfiguredHeaders, ProjectManifest } from '@stayingupwind/core/manifest';
import {
  HOP_BY_HOP_HEADERS,
  PASSTHROUGH_RESPONSE_HEADER_DENYLIST,
  type PassthroughResponseContext,
  PLATFORM_HEADER_PREFIX,
  rewriteSetCookieForPreview,
} from '@stayingupwind/core/request';

import { nominatedBy, statusAllowsLength } from './responses.ts';

const SET_COOKIE_HEADER = 'set-cookie';
const CONNECTION_HEADER = 'connection';
const CONTENT_LENGTH_HEADER = 'content-length';

/** Coding, framing and entity tags describe the optimizer's bytes; it does not offer ranges. */
const IMAGE_ENTITY_HEADERS: ReadonlySet<string> = new Set([
  'accept-ranges',
  'content-encoding',
  'content-length',
  'content-range',
  'etag',
]);

/** Successful optimizer responses own their byte metadata, protections and cache marker. */
export const IMAGE_OPTIMIZER_HEADERS: ReadonlySet<string> = new Set([
  ...IMAGE_ENTITY_HEADERS,
  'content-disposition',
  'content-security-policy',
  'vary',
  'x-nextjs-cache',
]);

/** Supplement image headers without replacing byte metadata or exporting a hop's fields. */
export function layImageConfiguredUnder(
  headers: Headers,
  configured: ConfiguredHeaders,
  scope: PassthroughResponseContext,
): void {
  const connection = configured.headers['connection'];
  const nominated =
    connection === undefined
      ? undefined
      : new Set(connection.split(',').map((option) => option.trim().toLowerCase()));
  for (const [name, value] of Object.entries(configured.headers)) {
    const normalized = name.toLowerCase();
    if (
      IMAGE_ENTITY_HEADERS.has(normalized) ||
      HOP_BY_HOP_HEADERS.includes(normalized) ||
      normalized.startsWith(PLATFORM_HEADER_PREFIX) ||
      nominated?.has(normalized) === true
    ) {
      continue;
    }
    setConfiguredUnder(headers, name, value, scope);
  }
}

/**
 * A stored file or router part's configured fields, before independent middleware.
 * A rule's Connection names only that rule layer's hop fields (RFC 9110, 7.6.1); the file's
 * byte metadata still belongs to the representation. Iterate once, as the original overlay did.
 */
export function layStoredConfiguredOver(
  headers: Headers,
  configured: ConfiguredHeaders | undefined,
  scope: PassthroughResponseContext,
  entityHeaders: ReadonlySet<string>,
): void {
  const fields = configured?.headers ?? {};
  const connection = fields[CONNECTION_HEADER];
  const nominated =
    connection === undefined
      ? undefined
      : new Set(connection.split(',').map((option) => option.trim().toLowerCase()));
  for (const [name, value] of Object.entries(fields)) {
    const normalized = name.toLowerCase();
    if (
      entityHeaders.has(normalized) ||
      HOP_BY_HOP_HEADERS.includes(normalized) ||
      normalized.startsWith(PLATFORM_HEADER_PREFIX) ||
      nominated?.has(normalized) === true
    ) {
      continue;
    }
    setConfigured(headers, name, value, scope);
  }
}

/**
 * A rule's value as it goes out: a `Set-Cookie` scoped as a Function's is
 * (`rewriteSetCookieForPreview`), so that on a host under the shared domain a `Domain` that would
 * hand the cookie to every other site under it is taken off; anything else as the rule wrote it.
 */
function scopedValue(name: string, value: string, scope: PassthroughResponseContext): string {
  return name.toLowerCase() === SET_COOKIE_HEADER
    ? rewriteSetCookieForPreview(value, scope)
    : value;
}

/**
 * Setting a header a `next.config` rule gives a request, whose name may not be one a header can have.
 *
 * A rule may put what the request's path captured into a header's name, as Next.js lets it
 * (`x-slug-:slug`), and what comes out is whatever the visitor's URL made of it: `x-$1` over a
 * capture that spans segments is `x-a/b`. `Headers` refuses such a name with a throw, which failed
 * the whole answer — the file, the image — over one header the application could not have sent
 * either. Left off instead, and the rest of the answer is the application's. A document the edge
 * composes is not at risk: the rules reach it only through the shell's allowlist of names.
 *
 * The native setter checks the value without a separate validation pass.
 * The result lets a retained generation decline replay instead of dropping
 * one of its recorded protections; configured-rule callers keep their existing omission policy.
 */
export function setConfigured(
  headers: Headers,
  name: string,
  value: string,
  scope: PassthroughResponseContext,
): boolean {
  try {
    headers.set(name, scopedValue(name, value, scope));
    return true;
  } catch {
    // Not a header, on this request: left off.
    return false;
  }
}

/** The same, under what the answer already has: a header it holds stands. */
export function setConfiguredUnder(
  headers: Headers,
  name: string,
  value: string,
  scope: PassthroughResponseContext,
): void {
  try {
    if (!headers.has(name)) {
      headers.set(name, scopedValue(name, value, scope));
    }
  } catch {
    // As above: `has` refuses such a name as `set` does.
  }
}

/**
 * What a redirect of `next.config` puts among a manifest's header rules: the `Location` it answers
 * with, and nothing else. The rules are every routing rule that names a header, a redirect's
 * included, and say nothing of which of them answers, so a `Location` judged among them may be a
 * redirect's.
 */
const LOCATION_HEADER = 'location';

interface ConfiguredAnswerContext {
  readonly forwarding: PassthroughResponseContext;
  readonly request: Pick<Request, 'method'>;
  readonly later?: ReadonlySet<string> | undefined;
}

/** Remove actual field names, never malformed Connection options, from a stable list. */
function removeNominatedFields(headers: Headers, nominated: ReadonlySet<string> | undefined): void {
  const names = [...headers.keys()];
  for (const name of names) {
    if (nominated?.has(name) === true) headers.delete(name);
  }
}

/** Set an already-filtered deferred field; cookies accumulate beside the answer's own. */
function layDeferredField(
  headers: Headers,
  name: string,
  value: string,
  scope: PassthroughResponseContext,
): void {
  if (name !== SET_COOKIE_HEADER) {
    setConfigured(headers, name, value, scope);
    return;
  }
  try {
    headers.append(name, scopedValue(name, value, scope));
  } catch {
    // Not a header value, on this request: left off.
  }
}

/**
 * The headers the rules of `next.config` set on a request, laid on an answer a Function left them
 * off (`HEADER_RULES_LEFT_HEADER`), as the runtime lays what routing collected on its answer
 * (`withRoutingHeaders`): over the answer's own, and a cookie beside the answer's, scoped as every
 * cookie a Function answers with is. What the edge takes off every answer it hands on
 * (`forwardedResponse`) is not a rule's to put back, and a name no header can have is left off.
 * The Function's and the rules' `Connection` options apply before middleware is merged: the
 * runtime would have laid the rules before forwarding removed the one hop's fields. A HEAD's
 * configured length is kept under the same status policy as an ordinary forwarded answer. A
 * field routing set later (`context.later`) keeps its value above these earlier rules; a later
 * Connection replaces the earlier Connection before its nominations are considered.
 *
 * The Function leaves off only the rules that set headers. Its redirects ahead of the middleware
 * stay, each with its `Location`, so none is laid here: on any other answer — a path a redirect
 * claims, which the middleware rewrote, answered by the route it was rewritten to — a redirect's
 * `Location` would stand on a 200. A rule that names `Location` without redirecting is left off with
 * it, since the rules cannot tell the two apart.
 */
export function layConfiguredOver(
  headers: Headers,
  configured: ConfiguredHeaders,
  answer: Response,
  context: ConfiguredAnswerContext,
): void {
  const { later } = context;
  const connection =
    later?.has(CONNECTION_HEADER) === true ? undefined : configured.headers[CONNECTION_HEADER];
  const nominated = nominatedBy(answer.headers, connection);
  if (connection !== undefined) {
    removeNominatedFields(headers, nominated);
  }
  const scope = context.forwarding;
  for (const [name, value] of Object.entries(configured.headers)) {
    if (later?.has(name) === true) continue;
    const length =
      name === CONTENT_LENGTH_HEADER &&
      context.request.method === 'HEAD' &&
      statusAllowsLength(answer, value);
    // The configured value replaces the old one even where this status cannot carry it.
    if (name === CONTENT_LENGTH_HEADER && !length) headers.delete(CONTENT_LENGTH_HEADER);
    if (
      name === LOCATION_HEADER ||
      (!length && PASSTHROUGH_RESPONSE_HEADER_DENYLIST.includes(name)) ||
      name.startsWith(PLATFORM_HEADER_PREFIX) ||
      nominated?.has(name) === true
    ) {
      continue;
    }
    layDeferredField(headers, name, value, scope);
  }
}

/**
 * Whether the rules a manifest carries are every rule of `next.config` that sets a header: a build
 * whose routing the edge reproduces publishes them all, and its dynamic routes, an empty list
 * included. One it does not — with `i18n` — publishes only the rules `next build` writes itself, and
 * folds its others into its routes' headers (`foldedHeaderRules`), which no request is judged by.
 */
function judgesEveryHeaderRule(manifest: ProjectManifest): boolean {
  return manifest.dynamicRoutes !== undefined && manifest.foldedHeaderRules === undefined;
}

/**
 * What the middleware decided, with the headers the rules ahead of the middleware set on the request
 * as the client sent it (`aheadOfMiddleware` of `configured`, judged before the middleware ran)
 * beside a decision to let the request on (`MiddlewareContinued.judgedRules`), for the Function it
 * may be handed to: what Next.js lays on whatever answers it. The Function judges the rest itself on
 * the request as it is finally matched, as Next.js judges a rule that runs on a match: one judged
 * here — the year-long `Cache-Control` of a build's own assets — went on whatever answered a request
 * the middleware moved off such a file. Not where a rule says no phase (a manifest from before they
 * did), of which nothing can be told ahead, nor where the manifest holds only some of the rules
 * (`judgesEveryHeaderRule`): the Function judges them all, as it did, and the edge lays none. A
 * matched `Location` is left to the Function too: the manifest cannot tell a header rule's from a
 * redirect's. Telling the Function to leave it off, then dropping it here as a possible redirect,
 * would lose a header that the Function used to answer with.
 */
export function withJudgedRules<Outcome extends { readonly kind: string }>(
  outcome: Outcome,
  configured: ConfiguredHeaders,
  manifest: ProjectManifest,
): Outcome {
  const judged = configured.aheadOfMiddleware;
  return judged !== undefined &&
    outcome.kind === 'continue' &&
    !Object.hasOwn(judged.headers, LOCATION_HEADER) &&
    judgesEveryHeaderRule(manifest)
    ? { ...outcome, judgedRules: judged }
    : outcome;
}

/** Iterate valid names: a Connection option need not itself be a valid header name. */
function withoutNominated(
  headers: Headers,
  original: Headers,
  nominated: ReadonlySet<string>,
): void {
  for (const name of original.keys()) {
    if (nominated.has(name)) {
      headers.delete(name);
    }
  }
}

/**
 * The headers the rules of `next.config` set, laid under a redirect or a whole response the
 * middleware answered with, as Next.js's router lays them: collected ahead of the middleware, each
 * replaced by one of the middleware's own of the same name (`resolve-routes.js`), and all put on the
 * response before it redirects or sends the middleware's body (`router-server.js`). A rule's cookie
 * goes out ahead of the middleware's, as `@next/routing` collects the two for the application's
 * Worker and as every other answer here carries them — Next.js's own server keeps the middleware's
 * alone — so of a cookie both set the middleware's is the one that stands; each is scoped as any
 * is. What the edge takes off every answer it hands on (`forwardedResponse`) is not a rule's to put
 * back.
 */
export function layConfiguredUnder(
  headers: Headers,
  configured: ConfiguredHeaders,
  scope: PassthroughResponseContext,
  original: Headers,
): void {
  // The middleware's Connection replaces the rule's as any of its headers does. Keep its
  // nominations until after forwarding has removed Connection itself (RFC 9110, 7.6.1).
  const connection = original.get('connection') ?? configured.headers['connection'];
  const nominated =
    connection === undefined
      ? undefined
      : new Set(connection.split(',').map((name) => name.trim().toLowerCase()));
  if (nominated !== undefined) {
    withoutNominated(headers, original, nominated);
  }
  for (const [name, value] of Object.entries(configured.headers)) {
    if (nominated?.has(name) === true) {
      continue;
    }
    if (name === SET_COOKIE_HEADER) {
      const own = headers.getSetCookie();
      headers.delete(SET_COOKIE_HEADER);
      setConfigured(headers, name, value, scope);
      for (const cookie of own) {
        headers.append(SET_COOKIE_HEADER, cookie);
      }
    } else if (
      !PASSTHROUGH_RESPONSE_HEADER_DENYLIST.includes(name) &&
      !name.startsWith(PLATFORM_HEADER_PREFIX)
    ) {
      setConfiguredUnder(headers, name, value, scope);
    }
  }
}
