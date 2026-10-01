import { UPWIND_AUTH_BASE_PATH, UPWIND_AUTH_SECRET_ENV } from '@stayingupwind/core/paas';

import { envValue, isProduction } from './environment.ts';

/**
 * What sessions and tokens are signed with, and where it is allowed to come from.
 *
 * Three sources, and the order between them is the whole design:
 *
 * 1. what the project wrote in its config — `secret`, which outranks everything;
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

/** The names Better Auth itself reads, in its own order. */
const DEVELOPER_SECRET_NAMES: readonly string[] = ['BETTER_AUTH_SECRET', 'AUTH_SECRET'];

/** A secret the developer chose, wherever they chose it. `options.secret` is the caller's to check. */
export function developerSecret(): string | undefined {
  for (const name of DEVELOPER_SECRET_NAMES) {
    const value = envValue(name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * The secret to hand Better Auth, or nothing to hand it — which leaves it reading the environment
 * itself, exactly as it would without this package in the way.
 *
 * Nothing is returned for a developer-set secret on purpose. Reading it here and passing it back
 * would put the value through one more place for no gain; leaving it means Better Auth's own
 * precedence is the one that applies, including any it grows later.
 */
export function resolveSecret(configured: string | undefined): string | undefined {
  if (configured !== undefined || developerSecret() !== undefined) {
    return undefined;
  }
  return isProduction() ? undefined : envValue(UPWIND_AUTH_SECRET_ENV);
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
export function missingProductionSecret(configured: string | undefined): string | undefined {
  if (configured !== undefined || !isProduction() || developerSecret() !== undefined) {
    return undefined;
  }
  return `@stayingupwind/auth: this is a production run with no signing key, so ${UPWIND_AUTH_BASE_PATH} cannot answer. Set AUTH_SECRET in the deployment's environment — the value upwind keeps in .upwind/ is this machine's own and is deliberately not read here.`;
}
