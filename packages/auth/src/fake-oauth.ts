import { UPWIND_AUTH_BASE_PATH } from '@stayingupwind/core/paas';
import type { AuthContext, BetterAuthPlugin, OAuthProvider } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';

import { authorizePage } from './authorize-page.ts';
import { type Identity, readCode, signCode } from './code.ts';
import { DEV_PROVIDER_ID } from './dev-provider.ts';
import { isProduction } from './environment.ts';
import { overrideProviders } from './override-providers.ts';

/**
 * The OAuth provider upwind plays when there is nobody else to play it.
 *
 * Registering an application with GitHub or Google, getting two secrets out of a dashboard and into
 * an environment, and coming back to the code is a detour of ten minutes that happens before the
 * first line of the thing you actually sat down to build. This removes it: a project with no
 * credentials anywhere signs in against a provider that is this application, and the code that does
 * the signing in is the code that will talk to the real one.
 *
 * **It keeps the declared names.** A project that wrote `socialProviders: { github: {} }` calls
 * `signIn.social({ provider: 'github' })`, here and in production, and nothing in the application
 * changes when the credentials arrive — the stand-in is the provider with that id, until it is not.
 * That is the point of doing this by replacing the provider object (`override-providers.ts`) rather
 * than by adding one of upwind's own alongside.
 *
 * **Nothing leaves the machine.** The authorization step is a page this serves; the code exchange
 * and the userinfo call are function calls, not requests. So there is no host to be up, no port to
 * be free, and no Function fetching itself.
 *
 * **It cannot happen in production.** `defineAuth` decides whether to add this plugin at all, and
 * the plugin refuses again here — once in the override, once in the endpoint. Two checks of the same
 * fact, because the cost of them is nothing and the cost of being wrong is an application whose
 * sign-in page hands out sessions to anybody who types an address into it.
 */

/** The plugin's name, as Better Auth and anything reading a plugin list sees it. */
const PLUGIN_ID = 'upwind-fake-oauth';

/** The endpoint, relative to the base path — so `/__upwind/auth/fake/authorize` by default. */
const AUTHORIZE_PATH = '/fake/authorize';

/** What the one provider is called on the page, where a provider's real name would be. */
const DEV_PROVIDER_NAME = 'a provider you have not chosen yet';

/** The identity the page starts on. A name nobody will mistake for a real address. */
const SUGGESTED_EMAIL = 'dev@localhost';

/** What the stand-in hands back as the provider's profile: the identity, and nothing invented. */
type FakeProfile = Identity;

/** `Awaited` of what the account key resolver may answer, per `OAuthProvider`. */
function subjectOf(profile: FakeProfile): string {
  return `${profile.provider}:${profile.email}`;
}

/**
 * Where the browser is sent to authorize, worked out from where Better Auth said to come back to.
 *
 * The callback is `<base path>/callback/<provider id>`, composed per request from the context's own
 * base URL — so it carries the origin and the base path this application is actually reachable at,
 * which is exactly what this endpoint needs and is not otherwise knowable from inside a provider.
 * A callback of another shape (a provider with a `callbackPath` of its own) leaves the default,
 * which is the only case where this could be wrong and is one no stand-in of upwind's ever sets.
 */
function authorizeUrl(redirectURI: string, provider: string, state: string): URL {
  const callback = new URL(redirectURI);
  const marker = `/callback/${provider}`;
  const basePath = callback.pathname.endsWith(marker)
    ? callback.pathname.slice(0, -marker.length)
    : UPWIND_AUTH_BASE_PATH;
  const url = new URL(`${basePath}${AUTHORIZE_PATH}`, callback.origin);
  url.searchParams.set('provider', provider);
  url.searchParams.set('state', state);
  return url;
}

/**
 * One stand-in, under an id and a name that are somebody else's.
 *
 * The four methods are the whole of a provider. Two of them are ordinarily network calls and here
 * are not: the code carries the identity (`code.ts`), so exchanging it is reading it, and reading
 * the user back is reading it again. `emailVerified` is true because the address was typed into a
 * page this served — there is nobody else to have verified it, and a stand-in that reported
 * unverified would trip `requireEmailVerification` on every sign-in.
 */
function standIn(id: string, name: string, secret: string): OAuthProvider<FakeProfile> {
  return {
    id,
    name,
    createAuthorizationURL: ({ state, redirectURI }) => authorizeUrl(redirectURI, id, state),
    validateAuthorizationCode: async ({ code }) => {
      const identity = await readCode(secret, code);
      // The provider is checked as well as the signature: a code this application issued for one
      // provider is not a code for another, even though one key signs both.
      return identity?.provider === id
        ? { accessToken: code, tokenType: 'bearer', scopes: [] }
        : null;
    },
    getUserInfo: async (tokens) => {
      const { accessToken } = tokens;
      const identity = accessToken === undefined ? undefined : await readCode(secret, accessToken);
      if (identity?.provider !== id) {
        return null;
      }
      return {
        user: { name: identity.name, email: identity.email, emailVerified: true },
        data: identity,
      };
    },
    accountSubject: ({ profile }) => subjectOf(profile),
  };
}

/** A readable name for an address, so a signed-in user is not called `dev@localhost` everywhere. */
function nameFor(email: string): string {
  const local = email.slice(0, Math.max(0, email.indexOf('@'))) || email;
  return local.replaceAll(/[._-]+/gu, ' ').trim() || email;
}

/**
 * The providers to serve instead of the real ones: one stand-in per provider the project declared,
 * keeping its id and its name — or a single one under upwind's own id for a project that declared
 * none, which is what a project that has written nothing but `defineAuth()` has.
 */
function standIns(ctx: AuthContext): readonly OAuthProvider[] {
  if (isProduction()) {
    return ctx.socialProviders;
  }
  const replaced =
    ctx.socialProviders.length === 0
      ? [standIn(DEV_PROVIDER_ID, DEV_PROVIDER_NAME, ctx.secret)]
      : ctx.socialProviders.map((provider) => standIn(provider.id, provider.name, ctx.secret));
  // Said once, through Better Auth's own logger, because an application signing people in against
  // nothing is a thing a developer has to know is happening — and because the line that says it is
  // also the line that says how to stop it.
  ctx.logger.info(
    `upwind is standing in for ${replaced.map((provider) => provider.id).join(', ')}: this project has no OAuth credentials and no AUTH_SECRET, so no request leaves this machine. Set them and the real provider answers instead.`,
  );
  return replaced;
}

/**
 * Not found, in the shape a path under the base path that nothing serves would have anyway.
 *
 * What a production build gets if one of these ever reaches it, and what a request for a provider
 * this is not standing in for gets — in both cases because the honest answer is that there is
 * nothing here, and a message explaining the difference would be a message about how to get a
 * session out of it.
 */
function notFound(): Response {
  return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
}

export function fakeOAuth(): BetterAuthPlugin {
  return {
    id: PLUGIN_ID,
    ...overrideProviders(standIns),
    endpoints: {
      upwindFakeAuthorize: createAuthEndpoint(AUTHORIZE_PATH, { method: 'GET' }, async (c) => {
        if (isProduction() || c.request === undefined) {
          // No request at all means this was reached through `auth.api`, where a Better Auth
          // endpoint is an ordinary function call. Everything below is about a browser arriving
          // somewhere — the origin to come back to, the query the form filled in — so there is
          // nothing here to answer with, and `new URL('')` would make that a `TypeError` instead
          // of an answer.
          return notFound();
        }
        const url = new URL(c.request.url);
        const provider = url.searchParams.get('provider') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const standingIn = c.context.socialProviders.find((known) => known.id === provider);
        if (standingIn === undefined || state === '') {
          return notFound();
        }
        const email = url.searchParams.get('email')?.trim();
        if (email === undefined || email === '') {
          return new Response(
            authorizePage({
              provider,
              name: standingIn.name,
              state,
              suggested: SUGGESTED_EMAIL,
            }),
            {
              headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
            },
          );
        }
        // Built here rather than carried on the query string. A `redirect_uri` this endpoint
        // accepted from a caller would be an open redirect with a signature attached, on a server
        // whose whole security model is that it is only reachable from this machine — and the one
        // correct value is derivable: the base path is what this request's own path sits under.
        //
        // Taken off the request where the request has it, and from the configuration where it does
        // not — a trailing slash, or a router that matched this endpoint under some other spelling,
        // would otherwise cut the path in the wrong place and send the browser to a callback that
        // does not exist.
        const basePath = url.pathname.endsWith(AUTHORIZE_PATH)
          ? url.pathname.slice(0, -AUTHORIZE_PATH.length)
          : (c.context.options.basePath ?? UPWIND_AUTH_BASE_PATH);
        const callback = new URL(`${basePath}/callback/${provider}`, url.origin);
        callback.searchParams.set(
          'code',
          await signCode(c.context.secret, { email, name: nameFor(email), provider }),
        );
        callback.searchParams.set('state', state);
        return new Response(null, {
          status: 302,
          headers: { location: callback.href, 'cache-control': 'no-store' },
        });
      }),
    },
  };
}
