import type { AuthContext, BetterAuthPlugin, OAuthProvider } from 'better-auth';

/**
 * Where OAuth goes, changed by something other than the project's config.
 *
 * This is the seam, named once and used from one place today. A social provider in Better Auth is an
 * object with four methods — build an authorization URL, exchange a code, read the user back, say
 * which account this is — and every one of the endpoints a provider talks to is chosen inside those
 * methods. Which means overriding "where OAuth goes" is not a matter of editing a URL: the provider
 * object itself is the unit that can be replaced, and replacing it is the only override that covers
 * the whole flow.
 *
 * Better Auth's per-provider options offer `authorizationEndpoint` and nothing for the token
 * exchange or the userinfo call, so a project pointed at a local server by those options alone would
 * send its browser somewhere local and then exchange the code against the real provider. That is
 * worse than not overriding at all, which is why it is not what this does.
 *
 * A plugin's `init` is where it happens. What it returns under `context` is merged onto the live
 * context with `Object.assign`, so handing back a `socialProviders` array replaces the one the
 * endpoints read — after Better Auth has built the real providers from the project's declarations,
 * which is what lets a replacement keep their ids and names (`fake-oauth.ts`).
 */

/**
 * What a replacement is given — the whole context, not only the providers — and what it hands back.
 *
 * The context, because a replacement almost always needs something else off it: the providers a
 * project declared are what a stand-in keeps the names of, and the secret is what it signs with.
 * Passing the array alone would mean every caller closing over a context it was handed separately.
 */
export type ReplaceProviders = (ctx: AuthContext) => readonly OAuthProvider[];

/**
 * The `init` half of a plugin: everything needed to override where OAuth goes, and nothing else.
 *
 * A part of a plugin rather than a whole one, because an override rarely travels alone — the one
 * here brings endpoints of its own — and two plugins would mean two ids, two places to turn one
 * thing on, and an ordering between them that matters and is not written down.
 */
export function overrideProviders(replace: ReplaceProviders): Pick<BetterAuthPlugin, 'init'> {
  return {
    init: (ctx: AuthContext) => ({ context: { socialProviders: [...replace(ctx)] } }),
  };
}
