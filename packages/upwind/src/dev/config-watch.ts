import { type FSWatcher, realpathSync, watch } from 'node:fs';
import path from 'node:path';
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

/**
 * How long the names are left alone before a change counts.
 *
 * An editor that writes in place truncates the file and then writes it, and the first of those is a
 * change event for a file that is momentarily empty. Restarting on it would hand the replacement a
 * config it cannot parse, which ends the run instead of restarting it — so the last event wins, once
 * nothing has followed it.
 */
const SETTLE_MS = 150;

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
function lostWatch(where: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `upwind: cannot watch ${where} for config changes, so a change to next.config will not restart this server (${reason})`;
}

/** Stop watching: what a run calls when it is shutting down and a change is no longer its business. */
export type StopWatching = () => void;

/** For a run that has no watch to stop, so every caller has something to call. */
function watchNothing(): void {
  // There was never a watcher.
}

/**
 * The directories to watch, and the names to listen for in each.
 *
 * The project's own directory, for a config file being created, edited or removed there. And, for a
 * config file that is a symlink, the directory its target is in: editing that target changes nothing
 * about the link or about the entry beside the project, so nothing of it reaches a watch on the project
 * alone. A directory rather than the file, in both cases, because an editor that replaces a file writes
 * a new one over the name and the old inode hears nothing.
 */
function watchPoints(projectDir: string, names: readonly string[]): Map<string, Set<string>> {
  const points = new Map<string, Set<string>>([[projectDir, new Set(names)]]);
  for (const name of names) {
    let target;
    try {
      target = realpathSync(path.join(projectDir, name));
    } catch {
      // Not there, or a link to nothing: the watch on the project is what will see it appear.
      continue;
    }
    if (target === path.join(projectDir, name)) {
      continue;
    }
    const directory = path.dirname(target);
    const listening = points.get(directory) ?? new Set<string>();
    listening.add(path.basename(target));
    points.set(directory, listening);
  }
  return points;
}

/** The one debounce the watchers share: the last event anywhere is the one that counts. */
interface Settling {
  timer: NodeJS.Timeout | undefined;
}

/** One directory, watched for the names that matter in it, or nothing if it cannot be watched. */
function watchDirectory(
  directory: string,
  listening: ReadonlySet<string>,
  settling: Settling,
): FSWatcher | undefined {
  try {
    const watcher = watch(directory, (_event, filename) => {
      if (filename === null || !listening.has(filename)) {
        return;
      }
      clearTimeout(settling.timer);
      settling.timer = setTimeout(() => {
        restart(`${filename} changed`);
      }, SETTLE_MS);
    });
    watcher.on('error', (error: unknown) => {
      // Said rather than swallowed: a watch that dies mid-run stops restarting this server, and a
      // developer editing `next.config` with nothing happening deserves to know which of the two it is.
      console.warn(lostWatch(directory, error));
      watcher.close();
    });
    return watcher;
  } catch (error) {
    console.warn(lostWatch(directory, error));
    return undefined;
  }
}

export async function watchConfigFiles(projectDir: string): Promise<StopWatching> {
  const names = await nextConfigFiles(projectDir);
  if (names === undefined) {
    console.warn(
      'upwind: could not read the config file names from Next.js, so a change to next.config will not restart this server',
    );
    return watchNothing;
  }
  // A watch this cannot have is not worth the server, whether it is refused at the start — a machine
  // out of inotify watches refuses with `ENOSPC` — or lost later: a dev server that stops restarting
  // on a config change is still a dev server, and taking one down over this would be the worse
  // failure.
  const settling: Settling = { timer: undefined };
  const watchers: FSWatcher[] = [];
  for (const [directory, listening] of watchPoints(projectDir, names)) {
    const watcher = watchDirectory(directory, listening, settling);
    if (watcher !== undefined) {
      watchers.push(watcher);
    }
  }
  return () => {
    clearTimeout(settling.timer);
    for (const watcher of watchers) {
      watcher.close();
    }
  };
}
