import { type FSWatcher, readlinkSync, watch } from 'node:fs';
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

/**
 * `CONFIG_FILES` in `next/dist/shared/lib/constants.ts`, as that module hands it over.
 *
 * Both ways it can arrive. Node's lexer reads the names out of the CommonJS module and a named import
 * is what works today; a module whose shape it cannot read would put the whole of `module.exports`
 * under `default` instead, and the same names are there.
 */
async function nextConfigFiles(projectDir: string): Promise<readonly string[] | undefined> {
  const entry = resolveFromProject(projectDir, 'next/constants.js');
  if (entry === undefined) {
    return undefined;
  }
  try {
    const module = (await import(pathToFileURL(entry).href)) as {
      CONFIG_FILES?: unknown;
      default?: { CONFIG_FILES?: unknown };
    };
    const names = module.CONFIG_FILES ?? module.default?.CONFIG_FILES;
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

/** How far a chain of symlinks is followed. Long enough for any real one, bounded against a loop. */
const MAX_LINK_HOPS = 32;

/**
 * Every symlink on the way to what a name points at, and the path it ends at.
 *
 * Resolved component by component, the way the operating system resolves a path, because a link
 * anywhere along it is a thing that can be repointed: `next.config.js -> shared/current/next.config.js`
 * with `shared/current -> configs/a` is repointed at `current`, and a watch on the file that chain ends
 * at would never hear it. Each link met is a place to watch; each one also replaces what is left to
 * resolve, so the components of where it points are walked in their turn. The end is a place to watch
 * too, and may be a file that does not exist yet — a config symlinked to something nobody has written
 * is one that appears the moment they do.
 */
function linkPoints(start: string): string[] {
  const points: string[] = [];
  let remaining = start.split(path.sep).filter((part) => part !== '');
  let resolved: string = path.sep;
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops += 1) {
    const [part, ...rest] = remaining;
    if (part === undefined) {
      points.push(resolved);
      return points;
    }
    remaining = rest;
    resolved = path.join(resolved, part);
    let target;
    try {
      target = readlinkSync(resolved);
    } catch {
      // Not a link: either a plain entry, or one that is not there. Either way, on to the next part.
      continue;
    }
    points.push(resolved);
    // What the link points at is resolved from the start, since its own path may pass through links
    // as well; whatever was still to come after the link comes after that.
    const next = path.resolve(path.dirname(resolved), target);
    remaining = [...next.split(path.sep).filter((entry) => entry !== ''), ...remaining];
    resolved = path.sep;
  }
  // A chain this long is a loop, or close enough: what has been collected is watched, and the end of it
  // is wherever the walk stopped.
  points.push(resolved);
  return points;
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
    const reached = linkPoints(path.join(projectDir, name));
    for (const point of reached) {
      const directory = path.dirname(point);
      const listening = points.get(directory) ?? new Set<string>();
      listening.add(path.basename(point));
      points.set(directory, listening);
    }
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
