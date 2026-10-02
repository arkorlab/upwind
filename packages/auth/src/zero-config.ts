import type { BetterAuthOptions } from 'better-auth';

import { envValue, isProduction } from './environment.ts';
import { hasConfiguredSecret } from './secret.ts';

/**
 * Has anybody configured this project's authentication yet?
 *
 * One question, asked once, and everything upwind does for a project that has not is downstream of
 * it. The answer has to be about what the *developer* did, which is why nothing upwind itself
 * provides counts: the generated secret has a name of its own so that it cannot be mistaken for one
 * somebody chose (`UPWIND_AUTH_SECRET_ENV`), and the placeholder credentials `defineAuth` fills in
 * are decided after this has already answered.
 *
 * Wrong in one direction only. A project this calls configured gets no stand-in provider and the
 * ordinary "you have not set a client id" failure, which is a familiar thing to debug. A project
 * this called unconfigured when it was not would sign people in against nothing, which is not — so
 * every signal counts as configuration, and the absence of all of them is what it takes.
 *
 * A signing key is one of those signals, and that is deliberate rather than an overreach. It is
 * what sessions outlive a restart by, so a project that has named one has decided how it wants
 * authentication to work — and upwind replacing that project's OAuth provider after it had said so
 * would be upwind deciding it knew better. The zero-config case is a project that has decided
 * nothing yet, which is the only case where there is nothing to override.
 */

/**
 * What a credential is called, by convention, in an environment.
 *
 * Better Auth does not read these itself — a provider's `clientId` comes from the config and from
 * nowhere else — so this is not about finding credentials to use. It is about not standing in for a
 * provider in a project that plainly has real credentials to hand and has merely not wired them up
 * yet, which is a state every project passes through on its way to being configured.
 */
const CREDENTIAL_SUFFIXES: readonly string[] = ['CLIENT_ID', 'CLIENT_SECRET', 'CLIENT_KEY'];

/**
 * Are there credentials in the environment for a provider this project declared?
 *
 * Named after the providers, and not a sweep for anything ending in `CLIENT_ID`. The sweep is the
 * obvious implementation and it is wrong in a way that is hard to debug: a developer with
 * `STRIPE_CLIENT_ID` exported in their shell — or any of the dozen other things that use that
 * name — would find the stand-in quietly absent and `signIn.social` failing on a missing client id,
 * with nothing on screen connecting the two.
 *
 * Asking per declared provider loses nothing, because the thing being decided is whether to stand in
 * *for those providers*. Credentials for one the project has not declared say nothing about them:
 * there is no provider of that name to stand in for either way.
 */
function credentialsInEnvironment(options: BetterAuthOptions): boolean {
  const declared: Record<string, unknown> = options.socialProviders ?? {};
  return Object.keys(declared).some((id) => {
    const prefix = id.toUpperCase();
    return CREDENTIAL_SUFFIXES.some((suffix) => envValue(`${prefix}_${suffix}`) !== undefined);
  });
}

/** One provider's declaration, as much of it as this needs to look at. */
interface DeclaredProvider {
  clientId?: unknown;
  clientSecret?: unknown;
  clientKey?: unknown;
}

/**
 * Is this a credential somebody filled in?
 *
 * A non-empty string, or a list holding one: Better Auth's `clientId` takes `string | string[]`,
 * because some providers issue one id per platform. A reading that only knew about strings would
 * call a project with `clientId: ['…ios', '…android']` unconfigured and replace a provider it had
 * really set up.
 *
 * The empty string is nothing, and is the usual way a credential arrives half-written:
 * `process.env.GITHUB_CLIENT_ID ?? ''` is what the key looks like before the variable exists.
 */
export function hasCredential(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasCredential(entry));
  }
  return typeof value === 'string' && value !== '';
}

/**
 * Did the project's own config name a credential?
 *
 * A provider declared as a *function* counts without being called. Resolving it would mean awaiting
 * it, and this question is answered while the options are being assembled — before anything is
 * async. It is also a fair reading of the intent: nobody writes a function returning a config
 * without having something for it to return.
 */
function credentialsInOptions(options: BetterAuthOptions): boolean {
  const declared: Record<string, unknown> = options.socialProviders ?? {};
  return Object.values(declared).some((provider) => {
    if (typeof provider === 'function') {
      return true;
    }
    if (typeof provider !== 'object' || provider === null) {
      return false;
    }
    const { clientId, clientSecret, clientKey } = provider as DeclaredProvider;
    return hasCredential(clientId) || hasCredential(clientSecret) || hasCredential(clientKey);
  });
}

/**
 * Is this a project with nothing configured, in a run where standing in for a provider is allowed?
 *
 * Production is excluded before anything else is asked. A deployment with no configuration is a
 * deployment that is broken, and the thing to do about it is to say so (`missingProductionSecret`)
 * rather than to make it appear to work.
 */
export function isZeroConfig(options: BetterAuthOptions): boolean {
  if (isProduction() || hasConfiguredSecret(options)) {
    return false;
  }
  return !credentialsInOptions(options) && !credentialsInEnvironment(options);
}
