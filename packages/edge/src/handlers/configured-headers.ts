import type {
  ConfiguredHeaders,
  ProjectManifest,
  StaticFileAssetPrefix,
  StaticFileEntry,
} from '@stayingupwind/core/manifest';
import { HEADER_RULES_AFTER_HEADER } from '@stayingupwind/core/paas';
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
/** What follows the asset prefix in the path a file of the build's `_next` is asked for by. */
const NEXT_DIR = '/_next/';

/** A later routing phase owns these fields; absent on runtimes from before it says so. */
export function laterHeaderRules(answer: Response): Set<string> | undefined {
  const value = answer.headers.get(HEADER_RULES_AFTER_HEADER);
  if (value === null || value === '') return undefined;
  const names = value.split(',');
  // Native Headers validates each name without accepting whitespace or a malformed name list.
  try {
    for (const name of names) {
      if (name === '' || name !== name.toLowerCase()) return undefined;
      answer.headers.has(name);
    }
  } catch {
    return undefined;
  }
  const later = new Set(names);
  // A later Connection replaces the earlier routing and middleware Connection before forwarding.
  // Its nominations must not be restored by either of those earlier layers.
  if (!later.has('connection')) return later;
  const nominated = nominatedBy(answer.headers);
  if (nominated === undefined) return later;
  for (const name of nominated) later.add(name);
  return later;
}

/**
 * The rules judged on a request for a shipped file (`headerRulesAsRouted`), with what its entry
 * stores laid over them (`StaticFileEntry.headers`): every unconditional rule of a build whose rules
 * the edge does not judge on each request, in Next.js's order, judged against the file's path when
 * the manifest was written — the rules `next build` writes itself among them, which are all that
 * build publishes for the edge to judge, so what is stored of them is the later word on any header
 * both name. Its headers are the request's whoever asks, so whether the request chose any of the
 * answer (`conditioned`) is the judged rules' to say, and so is what the rules ahead of the
 * middleware set (`aheadOfMiddleware`), which only a build whose every rule the edge judges hands
 * on (`withJudgedRules`).
 *
 * Laid on whatever answers just as the judged rules are, so what a stored header may not replace is
 * what a judged one may not: on the file, what describes its bytes (`SHIPPED_FILE_ENTITY_HEADERS`,
 * in `static-file.ts`, which the manifest leaves off as well), and on an answer the middleware gives
 * itself, what that answer's own lays keep.
 *
 * A read of a field of the entry the request was classified by, and a copy of a few names: nothing
 * is matched for it here, nothing is read, and nothing is waited on. An entry that stores none —
 * every file of a build whose rules the edge judges, and of a manifest from before the field — is
 * answered with what was judged, as it was.
 */
export function withStoredFileHeaders(
  configured: ConfiguredHeaders,
  stored: Readonly<Record<string, string>> | undefined,
): ConfiguredHeaders {
  return stored === undefined
    ? configured
    : { ...configured, headers: { ...configured.headers, ...stored } };
}

/**
 * What a shipped file's entry stores for the spelling it was asked for by: the set judged on the
 * prefixed path (`assetPrefixHeaders`) for a request under the application's asset prefix's
 * `_next`, where the entry stores one, and its own name's (`headers`) for any other. Only an entry
 * of the build's `_next`, under its base path, stores the prefixed set, and the prefix is not that
 * base path (`assetPrefixRewrite`), so a request under the prefix's `_next` found such an entry by
 * taking the prefix off (`withoutAssetPrefix`, in `staticFileKey`) and by nothing else: telling the
 * two apart is reading whether the path begins with the prefix, for an entry that has a second set
 * at all — and nothing for one that has none, which is every entry but those.
 */
export function storedAsAsked(
  file: Pick<StaticFileEntry, 'assetPrefixHeaders' | 'headers'>,
  prefix: StaticFileAssetPrefix | undefined,
  pathname: string,
): Readonly<Record<string, string>> | undefined {
  const { assetPrefixHeaders } = file;
  if (assetPrefixHeaders === undefined || prefix === undefined) {
    return file.headers;
  }
  const { assetPrefix } = prefix;
  const prefixed =
    pathname.startsWith(assetPrefix) && pathname.startsWith(NEXT_DIR, assetPrefix.length);
  return prefixed ? assetPrefixHeaders : file.headers;
}

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

/** The same, beside what the answer already has: a cookie goes with the answer's own. */
export function appendConfigured(
  headers: Headers,
  name: string,
  value: string,
  scope: PassthroughResponseContext,
): void {
  try {
    headers.append(name, scopedValue(name, value, scope));
  } catch {
    // As above.
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
