import { UPWIND_AUTH_BASE_PATH, UPWIND_AUTH_SECRET_ENV } from '@stayingupwind/core/paas';

import { envValue, isProduction } from './environment.ts';

/**
 * What sessions and tokens are signed with, and where it is allowed to come from.
 *
 * Three sources, and the order between them is the whole design:
 *
 * 1. what the project wrote in its config — `secret`, or `secrets` for a project rotating keys,
 *    either of which outranks everything;
 * 2. what the developer put in the environment — `BETTER_AUTH_SECRET`, then `AUTH_SECRET`, which is
 *    Better Auth's own order and is left to Better Auth to read;
 * 3. what upwind generated for a project that named none — `UPWIND_AUTH_SECRET`, kept in `.upwind/`
 *    by the CLI and read here last.
 *
 * The third exists so that a project being set up has sessions that survive a restart. It is also
 * what makes the first two meaningful: "did the developer configure a secret" is a question upwind
 * must be able to answer, and it could not if upwind's own answer were written to the same names
 * (`UPWIND_AUTH_SECRET_ENV` says the same thing from the other side).
 *
 * A production run gets none of the third. It gets a secret the developer set or it gets an error
 * naming what is missing — never a key that this machine generated and no other machine has.
 */

/**
 * Every name Better Auth itself reads a key out of.
 *
 * Three, not two: `BETTER_AUTH_SECRETS` is the rotation form — `2:key,1:key` — and Better Auth
 * reads it in the same breath as the other two (`options.secrets ?? parseSecretsEnv(…)`). A
 * deployment that rotates keys has its key *there* and nowhere else, so a reading that knew only
 * about the singular names would call it unconfigured: refused in production, and in development
 * handed a generated key over the top of its rotation.
 */
const SECRET_NAMES: readonly string[] = [
  'BETTER_AUTH_SECRET',
  'AUTH_SECRET',
  'BETTER_AUTH_SECRETS',
];

/**
 * What the project itself said about its signing key, in either of the two places it can say it.
 *
 * Both, always, and that is the point of there being a type for it: `secrets` is how a project
 * rotates keys without invalidating what the old one signed, and a reading that saw only `secret`
 * would call such a project unconfigured — refusing to serve it in production, and shadowing its
 * rotation with a generated key in development.
 */
export interface ConfiguredSecret {
  readonly secret?: string | undefined;
  readonly secrets?: unknown;
}

/**
 * Did the developer name a signing key, anywhere they are allowed to name one?
 *
 * The one question, asked from one place. Whether a run may be stood in for, whether a production
 * run may answer at all, and whether upwind's generated key is read — all three turn on it, and
 * three readings of it would be three chances to disagree.
 */
export function hasConfiguredSecret(options: ConfiguredSecret): boolean {
  if (options.secret !== undefined || options.secrets !== undefined) {
    return true;
  }
  return SECRET_NAMES.some((name) => envValue(name) !== undefined);
}

/**
 * The secret to hand Better Auth, or nothing to hand it — which leaves it reading the environment
 * itself, exactly as it would without this package in the way.
 *
 * Nothing is returned for a developer-set secret on purpose. Reading it here and passing it back
 * would put the value through one more place for no gain; leaving it means Better Auth's own
 * precedence is the one that applies, including any it grows later.
 */
export function resolveSecret(options: ConfiguredSecret): string | undefined {
  if (hasConfiguredSecret(options) || isProduction()) {
    return undefined;
  }
  return envValue(UPWIND_AUTH_SECRET_ENV);
}

/**
 * Why a production run cannot start, when it cannot — checked at the first request rather than at
 * module evaluation.
 *
 * Evaluation happens while a Function is warming or while a page is being rendered, and a throw
 * there is an error about a module, at a moment nobody asked a question. The first request is where
 * somebody is asking, and is where a message that names the variable to set can be read as the
 * instruction it is.
 */
export function missingProductionSecret(options: ConfiguredSecret): string | undefined {
  if (!isProduction() || hasConfiguredSecret(options)) {
    return undefined;
  }
  return `@stayingupwind/auth: this is a production run with no signing key, so ${UPWIND_AUTH_BASE_PATH} cannot answer. Set AUTH_SECRET in the deployment's environment — the value upwind keeps in .upwind/ is this machine's own and is deliberately not read here.`;
}
