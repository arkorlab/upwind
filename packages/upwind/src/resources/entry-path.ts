/**
 * Where the module a build's processes are told to `--import` actually is.
 *
 * `upwind build` cannot publish anything for the build it starts: a symbol defined in this process
 * is not in the one `next build` runs, nor in the worker that renders pages, and it is that worker
 * which evaluates the application. So the child is told to import the publisher before it runs
 * anything, which is the one thing `NODE_OPTIONS` can say that reaches every process below it.
 *
 * Two spellings because this package runs as two things. A workspace links its sources and Node
 * reads the TypeScript directly; a registry copy is inside `node_modules`, where it does not, so
 * what runs there is the bundle — `dist/cli.js`, with the publisher beside it as its own entry.
 * This module is in both, so its own extension says which it is in.
 */

/**
 * Where the project is, named for every process below the build rather than left to be guessed.
 *
 * The working directory would usually be the same answer and is not guaranteed to be; this is.
 */
export const PROJECT_DIR_ENV = 'UPWIND_PROJECT_DIR';

/** The module the child imports, as a `file:` URL. */
export function localResourcesEntry(): string {
  const fromSources = import.meta.url.endsWith('.ts');
  // A URL, not a path: `NODE_OPTIONS` is split on whitespace, and a project under a directory with
  // a space in its name would otherwise be read as two options.
  return new URL(fromSources ? './entry.ts' : './resources-entry.js', import.meta.url).href;
}
