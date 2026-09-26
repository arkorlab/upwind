/**
 * The name a scaffolded project takes, which is the directory it was asked for.
 *
 * npm's rules, as far as one matters here: the manifest this writes is `private`, so nothing will
 * ever publish it — but a name npm refuses is one that `npm install` inside the project refuses too,
 * and finding that out on the first install is worse than finding it out now.
 *
 * `validate-npm-package-name` is the package that knows all of them. It is not a dependency here for
 * the same reason nothing else is: this runs once, from a registry, in somebody else's shell.
 */

/** npm's own limit. */
const MAX_LENGTH = 214;
/** What an unscoped name may be made of, as the registry accepts it. */
const ALLOWED = /^[a-z0-9._~-]+$/u;
/** The two names npm refuses outright, whatever else is true of them. */
const REFUSED: ReadonlySet<string> = new Set(['favicon.ico', 'node_modules']);

/** What is wrong with `name` as a package name, or nothing when it is a fine one. */
export function nameProblem(name: string): string | undefined {
  if (name === '') {
    return 'is empty';
  }
  if (REFUSED.has(name)) {
    return 'is a name npm will not take, whatever is in the directory';
  }
  if (name.length > MAX_LENGTH) {
    return `is longer than npm's ${MAX_LENGTH} characters`;
  }
  if (name !== name.toLowerCase()) {
    return 'has capital letters, which npm does not allow in a package name';
  }
  if (name.startsWith('.') || name.startsWith('_')) {
    return 'starts with a dot or an underscore, which npm does not allow in a package name';
  }
  if (!ALLOWED.test(name)) {
    return 'has characters npm does not allow in a package name (letters, digits, `.`, `-`, `_` and `~`)';
  }
  return undefined;
}
