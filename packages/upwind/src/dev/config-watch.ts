import { watch } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { resolveFromProject } from './next-app.ts';
import { restart } from './restart.ts';

/**
 * Restart the run when `next.config` changes.
 *
 * `next dev` does this in `startServer`, which a custom server does not go through — so without it a
 * developer would edit `next.config.ts` and go on being served by a server that read the old one.
 * Next.js restarts rather than reloads for the same reason this does: the config is what the bundler
 * was set up from.
 *
 * Which names count is Next.js's own list, read from the project's copy of Next.js rather than
 * written out here, so a release that learns a new config extension is not one this quietly stops
 * watching. It is read at runtime and not imported: `next/constants` is a path into a package with no
 * export map, and the copy that matters is the project's.
 */

/** `CONFIG_FILES` in `next/dist/shared/lib/constants.ts`, as that module hands it over. */
async function nextConfigFiles(projectDir: string): Promise<readonly string[] | undefined> {
  const entry = resolveFromProject(projectDir, 'next/constants.js');
  if (entry === undefined) {
    return undefined;
  }
  try {
    const module = (await import(pathToFileURL(entry).href)) as { CONFIG_FILES?: unknown };
    const names = module.CONFIG_FILES;
    if (!Array.isArray(names)) {
      return undefined;
    }
    const strings = names.filter((name): name is string => typeof name === 'string');
    return strings.length === 0 ? undefined : strings;
  } catch {
    return undefined;
  }
}

/** The one thing there is to say about a watch this run does not have. */
function lostWatch(projectDir: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `upwind: cannot watch ${projectDir} for config changes, so a change to next.config will not restart this server (${reason})`;
}

export async function watchConfigFiles(projectDir: string): Promise<void> {
  const names = await nextConfigFiles(projectDir);
  if (names === undefined) {
    console.warn(
      'upwind: could not read the config file names from Next.js, so a change to next.config will not restart this server',
    );
    return;
  }
  // The *directory* is watched, not the files: only one of those names exists in a project, another
  // may be written while the server runs, and `fs.watch` on a path that is not there yet fails. One
  // watcher on the project root, filtered by name, covers a config file created, edited or removed.
  //
  // A watch this cannot have is not worth the server, whether it is refused at the start — a machine
  // out of inotify watches refuses with `ENOSPC` — or lost later: a dev server that stops restarting
  // on a config change is still a dev server, and taking one down over this would be the worse
  // failure.
  let watcher;
  try {
    watcher = watch(projectDir, (_event, filename) => {
      if (filename !== null && names.includes(filename)) {
        restart(`${filename} changed`);
      }
    });
  } catch (error) {
    console.warn(lostWatch(projectDir, error));
    return;
  }
  watcher.on('error', (error: unknown) => {
    // Said rather than swallowed: a watch that dies mid-run stops restarting this server, and a
    // developer editing `next.config` with nothing happening deserves to know which of the two it is.
    console.warn(lostWatch(projectDir, error));
    watcher.close();
  });
  watcher.unref();
}
