import type { ConfiguredHeaders, ProjectManifest } from '@stayingupwind/core/manifest';
import {
  PASSTHROUGH_RESPONSE_HEADER_DENYLIST,
  type PassthroughResponseContext,
  PLATFORM_HEADER_PREFIX,
  rewriteSetCookieForPreview,
} from '@stayingupwind/core/request';

import type { MiddlewareOutcome } from './middleware.ts';

const SET_COOKIE_HEADER = 'set-cookie';

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
 * A `try` around the call rather than a check before it, so a header that is fine costs nothing
 * more on a request.
 */
export function setConfigured(
  headers: Headers,
  name: string,
  value: string,
  scope: PassthroughResponseContext,
): void {
  try {
    headers.set(name, scopedValue(name, value, scope));
  } catch {
    // Not a header, on this request: left off.
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

/**
 * The headers the rules of `next.config` set on a request, laid on an answer a Function left them
 * off (`HEADER_RULES_LEFT_HEADER`), as the runtime lays what routing collected on its answer
 * (`withRoutingHeaders`): over the answer's own, and a cookie beside the answer's, scoped as every
 * cookie a Function answers with is. What the edge takes off every answer it hands on
 * (`forwardedResponse`) is not a rule's to put back, and a name no header can have is left off.
 * The original Function answer's `Connection` options apply to these deferred rules too: the
 * Function would otherwise have laid them before the edge removed the one hop's fields.
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
  scope: PassthroughResponseContext,
  nominated: ReadonlySet<string> | undefined,
): void {
  for (const [name, value] of Object.entries(configured.headers)) {
    if (
      name === LOCATION_HEADER ||
      PASSTHROUGH_RESPONSE_HEADER_DENYLIST.includes(name) ||
      name.startsWith(PLATFORM_HEADER_PREFIX) ||
      nominated?.has(name) === true
    ) {
      continue;
    }
    if (name === SET_COOKIE_HEADER) {
      try {
        headers.append(name, scopedValue(name, value, scope));
      } catch {
        // Not a header value, on this request: left off.
      }
    } else {
      setConfigured(headers, name, value, scope);
    }
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
 * What the middleware decided, with the headers the rules of `next.config` set on the request as
 * the client sent it (`configured`, judged before the middleware ran) beside a decision to let the
 * request on (`MiddlewareContinued.judgedRules`), for the Function it may be handed to. Not where the
 * manifest holds only some of the rules (`judgesEveryHeaderRule`): the Function judges them all, as
 * it did, and the edge lays none. A matched `Location` is left to the Function too: the manifest
 * cannot tell a header rule's from a redirect's. Telling the Function to leave it off, then dropping
 * it here as a possible redirect, would lose a header that the Function used to answer with.
 */
export function withJudgedRules<Outcome extends MiddlewareOutcome>(
  outcome: Outcome,
  configured: ConfiguredHeaders,
  manifest: ProjectManifest,
): Outcome {
  return outcome.kind === 'continue' &&
    !Object.hasOwn(configured.headers, LOCATION_HEADER) &&
    judgesEveryHeaderRule(manifest)
    ? { ...outcome, judgedRules: configured }
    : outcome;
}
