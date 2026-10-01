import type { BetterAuthOptions } from 'better-auth';

import { envNames, envValue, isProduction } from './environment.ts';
import { developerSecret } from './secret.ts';

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
 */

/**
 * What a credential is called, by convention, in an environment.
 *
 * Better Auth does not read these itself — a provider's `clientId` comes from the config and from
 * nowhere else — so this is not about finding credentials to use. It is about not standing in for a
 * provider in a project that plainly has real credentials to hand and has merely not wired them up
 * yet, which is a state every project passes through on its way to being configured.
 */
const CREDENTIAL_SUFFIXES: readonly string[] = ['CLIENT_ID', 'CLIENT_SECRET'];

function credentialsInEnvironment(): boolean {
  return envNames().some((name) => {
    const upper = name.toUpperCase();
    return (
      CREDENTIAL_SUFFIXES.some((suffix) => upper.endsWith(suffix)) && envValue(name) !== undefined
    );
  });
}

/** One provider's declaration, as much of it as this needs to look at. */
interface DeclaredProvider {
  clientId?: unknown;
  clientSecret?: unknown;
  clientKey?: unknown;
}

function isConfigured(value: unknown): boolean {
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
    return isConfigured(clientId) || isConfigured(clientSecret) || isConfigured(clientKey);
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
  if (isProduction()) {
    return false;
  }
  if (options.secret !== undefined || options.secrets !== undefined) {
    return false;
  }
  return (
    developerSecret() === undefined && !credentialsInOptions(options) && !credentialsInEnvironment()
  );
}
