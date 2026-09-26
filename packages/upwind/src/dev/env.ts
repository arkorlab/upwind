/**
 * A variable set for as long as something needs to read it, and put back afterwards.
 *
 * Next.js reads what this run tells it — which adapter to load, where this front door is — from the
 * environment, while it loads `next.config`. The environment is also what every process the project
 * starts inherits, and those are the project's own: an `upwind dev` launched from one project's tooling
 * that found this run's adapter path would load that adapter against another project, and a plain
 * `next dev` that found this run's address would reserve its own prefix for a server that is not its.
 *
 * So the values live for the config load and no longer. The one window that cannot be closed this way
 * is the load itself: a `next.config` that starts a process of its own while it is being evaluated
 * hands it the environment as Next.js is reading it, and there is no way to tell Next.js the same thing
 * without telling the process.
 */

/** Put the variable back as it was — set to what it held, or gone if it held nothing. */
export type RestoreEnv = () => void;

export function setEnv(name: string, value: string | undefined): RestoreEnv {
  const previous = process.env[name];
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
  return () => {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, name);
      return;
    }
    process.env[name] = previous;
  };
}
