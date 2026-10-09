import { type FSWatcher, lstatSync, readlinkSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { authConfigPaths } from '../auth/layout.ts';
import { resolveFromProject } from './next-app.ts';
import { restart } from './restart.ts';

/**
 * Restart the run when a config this run read at startup changes.
 *
 * `next.config` first. `next dev` does this in `startServer`, which a custom server does not go
 * through — so without it a developer would edit `next.config.ts` and go on being served by a server
 * that read the old one. Next.js restarts rather than reloads for the same reason this does: the
 * config is what the bundler was set up from.
 *
 * And the auth config, which upwind reads at startup and nowhere else: a project that gains one has
 * a route nobody wrote, and a project that loses one has a route importing a module that is gone.
 * Both are the same kind of staleness as the first, and the same restart settles them.
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
  return `upwind: cannot watch ${where}, so changes to the watched config or class sources will not restart this server (${reason})`;
}

/** Stop watching: what a run calls when it is shutting down and a change is no longer its business. */
export type StopWatching = () => void;

/** For a run that has no watch to stop, so every caller has something to call. */
function watchNothing(): void {
  // There was never a watcher.
}

/**
 * How many links are followed before a chain is taken for a loop.
 *
 * Forty, which is what Linux resolves (`MAXSYMLINKS`) and enough for any chain a project has. What
 * this bound is for is the loop: a link that points at itself, directly or around a ring, is followed
 * until something stops it, and nothing else here would. A chain longer than this is left where the
 * walk reached — the links collected so far are watched, so a config behind one is not unwatched, only
 * watched a step short of where it ends.
 */
const MAX_LINK_FOLLOWS = 40;

/** The components of an absolute path, below its root, with separators as this platform writes them. */
function componentsOf(absolute: string): string[] {
  const normalized = path.normalize(absolute);
  const { root } = path.parse(normalized);
  return normalized
    .slice(root.length)
    .split(path.sep)
    .filter((part) => part !== '');
}

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
 *
 * The walk starts at the path's own root rather than at a separator, because a drive letter is part of
 * the root on Windows and `\C:\…` is not a path anything can be read from. Only the links are counted
 * against the bound; the components are however many a project happens to be nested under.
 */
function linkPoints(start: string): string[] {
  const points: string[] = [];
  let remaining = componentsOf(start);
  let resolved = path.parse(path.normalize(start)).root;
  let follows = 0;
  while (remaining.length > 0) {
    const [part, ...rest] = remaining;
    remaining = rest;
    resolved = path.join(resolved, part ?? '');
    let target;
    try {
      target = readlinkSync(resolved);
    } catch {
      // Not a link: either a plain entry, or one that is not there. Either way, on to the next part.
      continue;
    }
    if (follows >= MAX_LINK_FOLLOWS) {
      // A chain this long is a loop, or close enough. What was collected is watched all the same.
      break;
    }
    follows += 1;
    points.push(resolved);
    // What the link points at is resolved from its own root, since its path may pass through links as
    // well; whatever was still to come after the link comes after that.
    const next = path.resolve(path.dirname(resolved), target);
    remaining = [...componentsOf(next), ...remaining];
    resolved = path.parse(path.normalize(next)).root;
  }
  points.push(resolved);
  return points;
}

/**
 * Is this a directory a watch can be put on?
 *
 * A directory, and not merely something that exists: a watch on a *file* is a watch on that file's
 * inode, which says nothing about the directory that replaces it. `stat` rather than `lstat`, since a
 * link to a directory is as good a place to watch as the directory itself — and a link to nothing is
 * not there at all, which is the answer either way.
 */
function isWatchableDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directory to watch for a path, and the name to listen for in it.
 *
 * Ordinarily the path's own parent. Where that parent is not there either — a config symlinked to
 * `shared/generated/config.js` before anything has generated it — the nearest directory that *is*,
 * listening for the name of the next thing to appear in it. A watch cannot be put on a directory that
 * does not exist, and the one that will hold it is the one that says when it does.
 */
function watchFor(target: string): { directory: string; name: string } {
  let name = path.basename(target);
  let directory = path.dirname(target);
  // `dirname` of a root is the root, so this ends at the filesystem's own top whatever is missing.
  while (!isWatchableDirectory(directory) && path.dirname(directory) !== directory) {
    name = path.basename(directory);
    directory = path.dirname(directory);
  }
  return { directory, name };
}

/**
 * The directories to watch, and the names to listen for in each.
 *
 * The directory each file would be in, for one being created, edited or removed there. And, for a
 * file that is a symlink, the directory its target is in: editing that target changes nothing about
 * the link or about the entry beside the project, so nothing of it reaches a watch on the project
 * alone. A directory rather than the file, in both cases, because an editor that replaces a file writes
 * a new one over the name and the old inode hears nothing.
 *
 * Absolute paths rather than names under one directory, because what is watched is no longer only the
 * project's own: an auth config sits beside `app`, which may be `src` (`auth/layout.ts`). A path whose
 * directory is not there yet is watched where it would appear — `watchFor` walks up to the nearest
 * directory that exists, so a project that has no `src` is watched for one being made.
 */
function watchPoints(files: readonly string[]): Map<string, Set<string>> {
  const points = new Map<string, Set<string>>();
  const listen = (directory: string, name: string): void => {
    const listening = points.get(directory) ?? new Set<string>();
    listening.add(name);
    points.set(directory, listening);
  };
  for (const file of files) {
    const { directory, name } = watchFor(file);
    listen(directory, name);
    for (const point of linkPoints(file)) {
      const reached = watchFor(point);
      listen(reached.directory, reached.name);
    }
  }
  return points;
}

/** The one debounce the watchers share: the last event anywhere is the one that counts. */
interface Settling {
  timer: NodeJS.Timeout | undefined;
}

/**
 * What one name looks like now, or nothing where it is not there.
 *
 * `lstat`, so the answer is about the entry rather than about whatever it points at: a watch point
 * here may well *be* a symlink — `watchPoints` adds the link's own name — and a link repointed at
 * another file is exactly the change this exists to catch. `stat` would have read the new target's
 * modification time, which a repointed link can share with the old one and often does.
 *
 * Three fields rather than one, because a replacement is a new entry: an editor writing a config in
 * place moves the modification time, and `rm`ing a link and making another moves the inode.
 */
function entryNow(file: string): string | undefined {
  try {
    const entry = lstatSync(file);
    return `${String(entry.mtimeMs)}:${String(entry.ino)}:${String(entry.size)}`;
  } catch {
    return undefined;
  }
}

/** What each of these names looks like now, for an event that will not say which one moved. */
function entriesNow(directory: string, listening: ReadonlySet<string>): Map<string, string> {
  const entries = new Map<string, string>();
  for (const name of listening) {
    const entry = entryNow(path.join(directory, name));
    if (entry !== undefined) {
      entries.set(name, entry);
    }
  }
  return entries;
}

/** Move one name's baseline on to whatever it is now, absent included. */
function remember(directory: string, name: string, seen: Map<string, string>): void {
  const entry = entryNow(path.join(directory, name));
  if (entry === undefined) {
    seen.delete(name);
  } else {
    seen.set(name, entry);
  }
}

/**
 * Which of the names this watch listens for has moved since it last looked, for an event that did
 * not say.
 *
 * `fs.watch` names the entry that changed on Linux, macOS, Windows and AIX, and nowhere else
 * (Node, `fs.watch` "Caveats") — a project on a filesystem it cannot ask, or a platform outside
 * that list, gets a `null` instead. Dropping those is a dev server that never restarts on a config
 * change and never says why; restarting on them is a dev server that restarts whenever anything
 * lands beside the config, which in the project's own directory is every lockfile and every
 * `.next`. So an unnamed event is answered by looking, which is the one reading that is neither.
 */
function movedAmong(
  directory: string,
  listening: ReadonlySet<string>,
  seen: Map<string, string>,
): string | undefined {
  let moved;
  for (const name of listening) {
    if (entryNow(path.join(directory, name)) === seen.get(name)) {
      continue;
    }
    moved ??= name;
    remember(directory, name, seen);
  }
  return moved;
}

/** One directory, watched for the names that matter in it, or nothing if it cannot be watched. */
function watchDirectory(
  directory: string,
  listening: ReadonlySet<string>,
  settling: Settling,
): FSWatcher | undefined {
  try {
    // Read before the watch rather than at the first unnamed event, so that the first change is one
    // this has something to compare against.
    const seen = entriesNow(directory, listening);
    const watcher = watch(directory, (_event, filename) => {
      // A named event this watch listens for is taken at its word. Anything else is looked at instead,
      // which covers the two cases a name cannot: a platform that reports none, and this directory
      // *itself* being moved or replaced — Linux reports that as its own basename, which is not a name
      // in here and is very much a change to what is in it.
      const named = filename !== null && listening.has(filename);
      const moved = named ? filename : movedAmong(directory, listening, seen);
      if (moved === undefined) {
        return;
      }
      // A named event moves the baseline on too, so that a later look does not report the change this
      // one already did and push the settling out by another round.
      remember(directory, moved, seen);
      clearTimeout(settling.timer);
      settling.timer = setTimeout(() => {
        restart(`${moved} changed`);
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
  // The auth config too, and for the same reason: what a run does about it, it does at startup
  // (`auth/prepare.ts`). A config that appears is one whose route nothing would write, and a config
  // that goes leaves a route importing it — both of which a restart settles, because startup is
  // where the route is decided.
  const files = [
    ...names.map((name) => path.join(projectDir, name)),
    ...authConfigPaths(projectDir),
  ];
  // A watch this cannot have is not worth the server, whether it is refused at the start — a machine
  // out of inotify watches refuses with `ENOSPC` — or lost later: a dev server that stops restarting
  // on a config change is still a dev server, and taking one down over this would be the worse
  // failure.
  return watchSourceFiles(files);
}

/** Class code is read at startup, just like a configuration file. */
export function watchSourceFiles(files: readonly string[]): StopWatching {
  const settling: Settling = { timer: undefined };
  const watchers: FSWatcher[] = [];
  for (const [directory, listening] of watchPoints(files)) {
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
