/**
 * The environment, as this package reads it.
 *
 * One function, because every reading here has to agree about the same two things. An empty string
 * is nothing: a `.env` line written as `AUTH_SECRET=` is a variable somebody meant to fill in and
 * has not, and treating it as a value would mean signing sessions with the empty string and deciding
 * that the project was configured. And the answer is always `string | undefined`, never the variable
 * itself, so nothing downstream can accidentally carry a secret's *presence* around as a boolean it
 * later re-reads.
 *
 * `process.env` and not a binding: a Function's text and secret bindings are what workerd puts
 * there, a development server has the project's `.env` there, and Better Auth reads its own
 * configuration from the same place. One environment, read one way.
 */

/** A variable's value, or nothing for one that is absent or empty. */
export function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** Every variable name the environment holds, for the questions that are about a shape of name. */
export function envNames(): readonly string[] {
  return Object.keys(process.env);
}

/**
 * Is this a production run?
 *
 * `NODE_ENV`, which Next.js sets itself — `development` under a dev server, `production` in a build
 * and in everything a build produced. Anything that is not exactly `production` is not production,
 * which is the safe direction for the one question this decides: whether upwind may stand in for an
 * OAuth provider. A run that lies about this to get a fake provider has only lied to itself.
 */
export function isProduction(): boolean {
  return envValue('NODE_ENV') === 'production';
}
