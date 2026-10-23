/**
 * The Cloudflare credentials a deploy uses, taken out of this process's environment before
 * anything of the project's runs.
 *
 * A deploy runs the project's own code: its `upwind.config.ts`, which this process evaluates, and
 * its build, which is a child of it. Neither has any reason to reach Cloudflare, and either could —
 * a config file, a module it imports, a page rendered at build time. So the token is read once,
 * kept here, and deleted from `process.env`, the environment every child inherits, before any of
 * that runs. Every other variable a Cloudflare tool takes a credential from goes with it, read or
 * not: a key this command never uses is still a key the build has no business holding.
 *
 * It is a reduction, not a boundary. On Linux a process of the same user can read this one's
 * initial environment (`/proc/<pid>/environ`), and the token was in it. The boundary is a build run
 * where the token is not: `upwind deploy --build-only` in a job without it, and `--prebuilt` in a
 * job with it.
 */

/** Where a deploy reads its API token. */
export const API_TOKEN_ENV = 'CLOUDFLARE_API_TOKEN';
/** Where a deploy reads the account to deploy to, when its configuration names none. */
export const ACCOUNT_ID_ENV = 'CLOUDFLARE_ACCOUNT_ID';

/** Every variable a Cloudflare tool reads a credential from, taken out whether this reads it or not. */
const CREDENTIAL_ENV: ReadonlySet<string> = new Set([
  ACCOUNT_ID_ENV,
  API_TOKEN_ENV,
  'CF_ACCOUNT_ID',
  'CF_API_KEY',
  'CF_API_TOKEN',
  'CF_EMAIL',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_API_USER_SERVICE_KEY',
  'CLOUDFLARE_EMAIL',
]);

export interface CloudflareCredentials {
  readonly apiToken: string;
  /** The account named in the environment; the deploy asks the token which it may reach otherwise. */
  readonly accountId: string | undefined;
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Read the credentials and take every credential variable out of the environment, in that order.
 * Nothing when no token was given: a run that only plans needs none.
 */
export function takeCredentials(
  env: Record<string, string | undefined> = process.env,
): CloudflareCredentials | undefined {
  const apiToken = present(env[API_TOKEN_ENV]);
  const accountId = present(env[ACCOUNT_ID_ENV]);
  for (const name of CREDENTIAL_ENV) {
    Reflect.deleteProperty(env, name);
  }
  return apiToken === undefined ? undefined : { apiToken, accountId };
}

/** Whether a variable of this name is one a deploy never hands a Function, whatever it holds. */
export function isCredentialVariable(name: string): boolean {
  return CREDENTIAL_ENV.has(name) || name.startsWith('CLOUDFLARE_');
}
