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
 * and in everything a build produced.
 *
 * Read as `process.env.NODE_ENV` and deliberately not through `envValue` above, because this one is
 * not a variable anybody looks up at run time: it is a *substitution*. `@stayingupwind/adapter`
 * builds a Function with `'process.env.NODE_ENV': '"production"'` defined, so that exact expression
 * becomes the string before the bundle is written. A computed `process.env[name]` is an expression no
 * bundler can replace, and nothing would replace it — workerd fills `process.env` from text and
 * secret bindings alone, and no deployment binds `NODE_ENV`. So the computed form answers `undefined`
 * in exactly the place where this question matters most, and every safeguard resting on it would be
 * off in production. Better Auth's own `isProduction` reads it the computed way and defaults to
 * `development`, which is the same trap from the other end and a second reason not to rely on it.
 *
 * The cast is what lets the expression be written at all: `ProcessEnv` is an index signature, and
 * this repository forbids reaching through one by property name. Casting to a type that declares the
 * name makes it an ordinary property read, and an ordinary property read is what compiles to the
 * expression the bundler is looking for.
 *
 * Anything that is not exactly `production` is not production, which is the safe direction for what
 * this decides: whether upwind may stand in for an OAuth provider, create tables, or let a run
 * without a signing key answer at all.
 */
export function isProduction(): boolean {
  return (process.env as { NODE_ENV?: string }).NODE_ENV === 'production';
}
