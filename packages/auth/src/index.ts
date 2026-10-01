import { UPWIND_AUTH_BASE_PATH } from '@stayingupwind/core/paas';
import { type Auth, betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';

import { projectDatabase } from './database.ts';
import { fakeOAuth } from './fake-oauth.ts';
import { resolveSecret } from './secret.ts';
import { isZeroConfig } from './zero-config.ts';

/**
 * Better Auth, with the four decisions a project has to make already made.
 *
 * ```ts
 * // auth.ts, beside your app
 * import { defineAuth } from '@stayingupwind/auth';
 *
 * export const auth = defineAuth();
 * ```
 *
 * That is a working sign-in. What it took was not writing four things, and each of them is a thing
 * upwind already knows:
 *
 * - **where it is served.** `/__upwind/auth`, and the route that serves it is written for you
 *   (`upwind dev` and `upwind build` do it). A project that sets a `basePath` of its own takes both
 *   back, and upwind's route steps aside.
 * - **what it signs with.** Whatever the developer set, and otherwise a key upwind generated and
 *   kept under `.upwind/` so that a restart does not sign everybody out. Never a generated key in
 *   production (`secret.ts`).
 * - **where it stores anything.** The one D1 database this deployment published, which for a local
 *   run is the one `upwind dev` made (`database.ts`). Nothing to name.
 * - **who signs people in.** The provider whose credentials are in the environment — or, while
 *   there are none, upwind itself (`fake-oauth.ts`).
 *
 * Everything is overridable and nothing is hidden: the options go to `betterAuth` as given, with
 * defaults filled into the gaps, so anything Better Auth documents works here and outranks this.
 * A project that outgrows all four of them is a project calling `betterAuth` directly, which is
 * also fine — `toNextHandler` serves whatever the config file exports.
 */

export { DEV_PROVIDER_ID } from './dev-provider.ts';
export { overrideProviders, type ReplaceProviders } from './override-providers.ts';
export { missingProductionSecret } from './secret.ts';

/**
 * What a provider declared without credentials is given, so that Better Auth builds it rather than
 * warning about it.
 *
 * It is never used. The provider object built from it is replaced wholesale before the first
 * request (`fake-oauth.ts`), and this run has already been shown to have no real credentials
 * anywhere. What it buys is a clean start-up: without it, a project whose whole config is
 * `socialProviders: { github: {} }` is greeted by a warning about the exact thing upwind is in the
 * middle of handling for it.
 */
const PLACEHOLDER_CREDENTIAL = 'upwind-development';

/**
 * Is this plugin already in the list the project gave?
 *
 * By id, and by an id read off the plugin rather than written out here — including Better Auth's
 * own, which is a name this package has no business knowing twice. A project that added one of
 * these itself keeps its own, and keeps the options it passed to it.
 */
function declares(declared: readonly BetterAuthPlugin[], plugin: BetterAuthPlugin): boolean {
  return declared.some((other) => other.id === plugin.id);
}

/**
 * The plugins to run, in the order they have to run in.
 *
 * `nextCookies` goes last, as its own documentation requires: it works by reading the headers
 * everything before it produced. The project's own come first, so a plugin of theirs sees the
 * context before upwind's stand-in has replaced anything.
 */
function plugins(declared: readonly BetterAuthPlugin[], zeroConfig: boolean): BetterAuthPlugin[] {
  const cookies = nextCookies();
  const fake = zeroConfig ? [fakeOAuth()] : [];
  return [
    ...declared,
    ...fake.filter((plugin) => !declares(declared, plugin)),
    ...(declares(declared, cookies) ? [] : [cookies]),
  ];
}

/**
 * The project's providers, with placeholder credentials where there are none to be had.
 *
 * Only in the zero-config case, and only for a provider declared as a plain object: a provider
 * declared as a function is one this never resolves (`zero-config.ts`), and rewriting the function
 * would mean calling it.
 */
function socialProviders(options: BetterAuthOptions): Record<string, unknown> {
  // Read as `unknown`, because what a declaration is at run time is not what its type promises: a
  // project may have written `{ github: null }` to turn one off, which Better Auth reads as "skip
  // this provider" and which filling in would quietly turn back on.
  const declared: Record<string, unknown> = options.socialProviders ?? {};
  const filled = Object.entries(declared).map(([name, provider]) => {
    if (typeof provider !== 'object' || provider === null) {
      return [name, provider] as const;
    }
    return [
      name,
      { clientId: PLACEHOLDER_CREDENTIAL, clientSecret: PLACEHOLDER_CREDENTIAL, ...provider },
    ] as const;
  });
  return Object.fromEntries(filled);
}

/**
 * The project's options with upwind's defaults in the gaps.
 *
 * Typed as the options that came in, and that is a claim worth reading carefully: what is added is
 * a base path, a secret, a database and two plugins, none of which adds an endpoint an application
 * calls by name. So `defineAuth` answers the `Auth` type the project's own declaration describes,
 * which is what makes `auth.api` and the client's inference the project's own rather than upwind's.
 * A plugin the project added is in `declared` and keeps every type it brought with it.
 */
function withUpwindDefaults<O extends BetterAuthOptions>(options: O): O {
  const zeroConfig = isZeroConfig(options);
  const secret = resolveSecret(options.secret);
  // Every default is a conditional spread rather than a `??`, so that a key the project did not
  // write is the only key this writes. The difference matters for `database`, whose declared type
  // reaches into optional driver packages that may not be installed: reading the value would mean
  // carrying a type nothing here can resolve, where asking whether it is there does not.
  return {
    ...options,
    ...(options.basePath === undefined && { basePath: UPWIND_AUTH_BASE_PATH }),
    ...(options.database === undefined && { database: projectDatabase() }),
    ...(secret !== undefined && { secret }),
    ...(zeroConfig && { socialProviders: socialProviders(options) }),
    plugins: plugins(options.plugins ?? [], zeroConfig),
  };
}

export function defineAuth<O extends BetterAuthOptions>(options?: O): Auth<O> {
  return betterAuth(withUpwindDefaults(options ?? ({} as O)));
}
