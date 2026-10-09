import { existsSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type DurableObjectDeclaration,
  durableObjectDeclarationsSchema,
  DURABLE_OBJECT_EXPORT,
} from '@stayingupwind/core/bundle';
import {
  formatResourcesManifest,
  type FunctionEnv,
  RESOURCES_MANIFEST_BINDING,
  type ResourceManifestEntry,
  type ResourceType,
  UPWIND_DURABLE_OBJECTS_ENV,
} from '@stayingupwind/core/paas';
import type { Miniflare, MiniflareOptions } from 'miniflare';

import { resolveFromProject } from '../dev/next-app.ts';
import { guardListeners } from './listeners.ts';
import { publishResources } from './publish.ts';

/**
 * A project's storage, locally: the same runtime a deployment's Functions run on, bound to
 * directories under the project instead of to a platform's namespaces.
 *
 * Nothing about it is configured, and that is the point being tried here — a project that has
 * written no configuration at all still has a database, a namespace and a bucket, and reads them
 * through `@stayingupwind/sdk` by the same route a deployed Function does: a manifest of what is
 * bound, `resourcesOf` over it, and the symbol that comes out. The short cut — handing the objects
 * straight to the application — would have been fewer lines and would have told us nothing about
 * whether the real route is any good to use.
 *
 * One instance, in the process the application is evaluated in: the dev server itself, or the one
 * worker a build renders its pages in. These bindings do not cross a process boundary, which is why
 * a supervisor or a build's parent starting one would be wasted work.
 */

/**
 * Where a project's local storage is kept: one directory of its own, beside `.next` and
 * `.arkor`. The runtime keeps a subdirectory per kind under it (`d1/`, `kv/`, `r2/`).
 *
 * Exported because it is not only storage's: it is the name of *this machine's copy of this
 * project*, which is also what an auth secret generated for a development run is (`auth/secret.ts`).
 * One definition, so that a release moving the directory moves everything under it at once.
 */
export const PERSIST_DIR = '.upwind';

/**
 * One directory of storage, one runtime that may write to it.
 *
 * A second runtime over the same `.upwind/` does not queue behind the first. Reading is fine —
 * several of them can read at once, as several readers of a SQLite database can — but a *write*
 * from the second dies inside the runtime, `SQLITE_BUSY` and fatal, taking the runtime with it and
 * leaving that query unanswered for good. There is nothing to catch, because nothing ever returns.
 *
 * Which is why the rule is kept here rather than discovered there: `claimStorage` takes the directory
 * for one process at a time, and a run that cannot have it says so before it publishes anything.
 *
 * `upwind dev` is one process and would never have met this anyway. A build renders in several, so
 * `upwind build` asks the adapter for one (`UPWIND_LOCAL_RESOURCES_ENV`, `experimental.cpus`) and
 * publishes only there (`entry.ts`) — a project that sets its own worker count keeps it, and then all
 * but one of its renderers is told, at startup, that something else has the storage.
 *
 * Miniflare's mechanism for several runtimes over one directory is `unsafeEnableSharedStorage`,
 * where instances elect an owner through a dev registry and reach storage through it. It is not
 * used here: against 5.20260925.0-alpha it works for two instances and deadlocks for six, and it
 * leaves a file watcher and a heartbeat timer that `Miniflare.dispose()` never clears (it calls the
 * registry's `unregisterWorkers`, not its `dispose`), so a process that turns it on can no longer
 * exit. `ProxyClient` — a client for a runtime you do not own, which is what would make several
 * renderers possible — is exported but refuses anyone but the instance that owns it.
 */

/**
 * The compatibility date the local runtime runs at.
 *
 * The date `@stayingupwind/adapter` builds a Function against (`FUNCTION_COMPATIBILITY_DATE`), so
 * that local storage behaves as a deployment's does rather than as whatever the installed runtime
 * defaults to. Written out rather than imported: this CLI resolves the adapter from the project it
 * was pointed at and does not depend on the package, so a release that moves that date moves this
 * line with it.
 */
const COMPATIBILITY_DATE = '2026-09-15';

/** The one worker there is. Its name appears in the storage paths, so it does not change. */
const WORKER_NAME = 'upwind-local';

/**
 * A key nothing is ever stored under. Read once per run, to prove the storage can be read at all.
 */
const PROBE_KEY = '__upwind_probe';

/**
 * Where the runs using this project's storage say so: one empty file each, named for its process.
 *
 * The rule being kept is the runtime's, and the runtime keeps it terribly: a second runtime over one
 * directory reads happily and then dies inside the first write, leaving that write unanswered for
 * good. Nothing can be caught there, so the conflict is caught here instead, before a binding is
 * published — a run writes its own name in, looks at who else is there, and stands down if anybody
 * live is.
 *
 * A file per process, rather than one file passed between them, and that is the whole design. A
 * shared file can only be taken over by removing it, and a removal by path cannot tell the claim it
 * read from the one that replaced it a moment later — two runs finding the same abandoned claim will
 * each delete the other's and both go on. A name nobody else writes has no such step: the only entry
 * a run ever creates or removes is its own, and the entries of processes that no longer exist, which
 * by definition hold nothing.
 *
 * Entries outlive the runs that made them. A build is the ordinary case: the pool gives a worker half
 * a second between `SIGTERM` and `SIGKILL`, and stopping a runtime can take longer than that. A pid
 * that answers nothing is what marks one as spent.
 */
const OWNERS_DIR = 'owners';

/**
 * How long all of that is waited for — starting the runtime, taking the bindings, reading through
 * them — before a run decides it has no storage after all.
 *
 * There is a deadline at all because none of those steps is guaranteed to answer: a runtime that
 * dies inside a query leaves it unanswered for good (`proveReadable`), and a build whose render
 * workers waited on that would never finish. Twenty seconds is far past a cold start, which is two
 * or three.
 */
const MS_IN_SECOND = 1000;
const START_SECONDS = 20;
const START_MS = START_SECONDS * MS_IN_SECOND;

/**
 * How long stopping the runtime is waited for before its own exit hook is left to it.
 *
 * Under the two seconds an `upwind dev` supervisor gives a child it has signalled before killing it
 * outright (`EXIT_GRACE_MS` in `dev/supervise.ts`), because this wait is inside that one: a shutdown
 * that waited longer would be a shutdown the supervisor interrupts, and the rest of what the dev
 * server does on its way out — closing the port, letting Next.js finish — would not happen.
 */
const STOP_MS = 1500;

/**
 * The runtime insists a worker have code. This one answers nothing and is never sent a request: it
 * exists so that its bindings do, and those are reached from Node rather than from a request.
 */
const ENTRY_MODULE = 'upwind-local.mjs';
const ENTRY_SOURCE = 'export default {};';

/**
 * The storage a project gets without asking for any.
 *
 * The names are what a developer reads in an error message and sees in `.upwind/`, so they say
 * where they came from. Nothing matches on them: `@stayingupwind/sdk` finds a database by there
 * being one of it rather than by its name, so a project that later declares storage of its own,
 * under its own names, is read exactly the same way.
 */
const DEFAULTS: readonly ResourceManifestEntry[] = [
  { name: 'UPWIND_D1', type: 'd1' },
  { name: 'UPWIND_KV', type: 'kv_namespace' },
  { name: 'UPWIND_R2', type: 'r2_bucket' },
];

/**
 * A second database, for trying the rule that decides a bare `db`.
 *
 * The one thing in here that exists for the trial rather than for a project: with two databases
 * published there is nothing for `db` to choose between, and what it says then is the behaviour
 * that cannot be seen with the defaults alone. It goes when the question it answers is settled.
 */
const TRIAL_TWO_D1_ENV = 'UPWIND_TRIAL_TWO_D1';
const TRIAL_SECOND_D1: ResourceManifestEntry = { name: 'UPWIND_D1_2', type: 'd1' };

const PACKAGE_MANIFEST = 'package.json';
const DEPENDENCY_FILES = [
  PACKAGE_MANIFEST,
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;

/** What the local runtime calls each kind of storage the contract names. */
const DURABLE_OBJECT_TYPE = 'durable_object_namespace';
const DURABLE_OBJECT_KIND = 'durable-object';

const RUNTIME_TYPES = {
  d1: 'd1',
  kv_namespace: 'kv',
  r2_bucket: 'r2',
  [DURABLE_OBJECT_TYPE]: DURABLE_OBJECT_KIND,
} as const satisfies Record<ResourceType, string>;

export interface LocalResources {
  /** Class dependencies whose edits require a fresh worker module. */
  readonly watchedFiles?: readonly string[];
  /** Detect edits between class bundling and the dev server attaching its watches. */
  readonly sourcesChanged?: () => boolean;
  /** Stop the local runtime. Call it as often as you like; the first call is the one that acts. */
  readonly dispose: () => Promise<void>;
}

export interface LocalOptions {
  /**
   * Whether this process answers interrupts itself, and so wants the runtime's signal handlers taken
   * back (`listeners.ts`). The dev server does; a process something else ends does not.
   */
  readonly answersSignals: boolean;
}

/** For a run with no local storage, so that every caller has something to call. */
const NOTHING_STARTED: LocalResources = {
  dispose: async () => {
    // Nothing was started, so there is nothing to stop.
  },
};

function bindings(): readonly ResourceManifestEntry[] {
  return process.env[TRIAL_TWO_D1_ENV] === '1' ? [...DEFAULTS, TRIAL_SECOND_D1] : DEFAULTS;
}

function sourceVersion(file: string): string {
  try {
    const stat = statSync(file, { bigint: true });
    return `${String(stat.mtimeNs)}:${String(stat.ctimeNs)}:${String(stat.size)}:${String(stat.ino)}`;
  } catch {
    return 'missing';
  }
}

function sourceChanges(versions: ReadonlyMap<string, string>): () => boolean {
  return () => [...versions].some(([file, version]) => sourceVersion(file) !== version);
}

function watchFile(file: string, watchedFiles: Set<string>, versions: Map<string, string>): void {
  watchedFiles.add(file);
  if (!versions.has(file)) versions.set(file, sourceVersion(file));
}

function watchDependencies(
  projectDir: string,
  watchedFiles: Set<string>,
  versions: Map<string, string>,
): void {
  let directory = path.resolve(projectDir);
  do {
    if (
      directory === path.resolve(projectDir) ||
      existsSync(path.join(directory, PACKAGE_MANIFEST))
    )
      for (const name of DEPENDENCY_FILES)
        watchFile(path.join(directory, name), watchedFiles, versions);
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  } while (directory !== path.dirname(directory));
}

function watchManifests(
  file: string,
  watchedFiles: Set<string>,
  versions: Map<string, string>,
): void {
  let directory = path.dirname(file);
  for (;;) {
    const manifest = path.join(directory, PACKAGE_MANIFEST);
    if (existsSync(manifest)) watchFile(manifest, watchedFiles, versions);
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

function noSourceChanges(): boolean {
  return false;
}

interface LocalDurableObject {
  readonly declaration: DurableObjectDeclaration;
  readonly source: string;
  readonly inputs: readonly string[];
}

function fileInBuildError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('location' in error)) return undefined;
  const { location } = error;
  if (typeof location !== 'object' || location === null || !('file' in location)) return undefined;
  return typeof location.file === 'string' ? location.file : undefined;
}

function watchBuildErrors(projectDir: string, error: unknown, watchedFiles: Set<string>): void {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('errors' in error) ||
    !Array.isArray(error.errors)
  )
    return;
  for (const failure of error.errors as unknown[]) {
    const file = fileInBuildError(failure);
    if (file !== undefined && file !== '<stdin>') watchedFiles.add(path.resolve(projectDir, file));
  }
}

async function durableObjectsOf(
  projectDir: string,
  watchedFiles: Set<string>,
  versions: Map<string, string>,
): Promise<readonly LocalDurableObject[]> {
  const raw = process.env[UPWIND_DURABLE_OBJECTS_ENV];
  if (raw === undefined || raw === '') return [];
  const declarations = durableObjectDeclarationsSchema.parse(JSON.parse(raw) as unknown);
  if (declarations.length === 0) return [];
  watchDependencies(projectDir, watchedFiles, versions);
  for (const declaration of declarations)
    watchFile(path.resolve(projectDir, declaration.module), watchedFiles, versions);
  const adapter = resolveFromProject(projectDir, '@stayingupwind/adapter');
  if (adapter === undefined)
    throw new Error('install @stayingupwind/adapter to run local Durable Objects');
  const module = (await import(pathToFileURL(adapter).href)) as {
    bundleDurableObjects?: (
      directory: string,
      objects: readonly DurableObjectDeclaration[],
      options: {
        readonly mode: 'development';
        readonly onSourceFile: (file: string) => void;
      },
    ) => Promise<LocalDurableObject[]>;
  };
  if (module.bundleDurableObjects === undefined)
    throw new Error(
      'the installed adapter does not support Durable Objects; install matching upwind packages',
    );
  const objects = await module.bundleDurableObjects(projectDir, declarations, {
    mode: 'development',
    onSourceFile: (file) => {
      watchFile(file, watchedFiles, versions);
      watchManifests(file, watchedFiles, versions);
    },
  });
  for (const object of objects)
    for (const file of object.inputs) {
      watchFile(file, watchedFiles, versions);
      watchManifests(file, watchedFiles, versions);
    }
  return objects;
}

/** A broken class stays watched and never takes away the project's other local storage. */
async function localObjects(
  projectDir: string,
  watchedFiles: Set<string>,
  versions: Map<string, string>,
): Promise<readonly LocalDurableObject[]> {
  try {
    const objects = await durableObjectsOf(projectDir, watchedFiles, versions);
    const defaults = new Set(bindings().map((entry) => entry.name));
    if (objects.some((object) => defaults.has(object.declaration.name)))
      throw new Error('a Durable Object name conflicts with local default storage');
    return objects;
  } catch (error) {
    watchBuildErrors(projectDir, error, watchedFiles);
    for (const file of watchedFiles) watchFile(file, watchedFiles, versions);
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `upwind: could not prepare local Durable Objects; default storage remains available:\n${reason}`,
    );
    return [];
  }
}

function ownerName(name: string): string {
  return `upwind-object-${name}`;
}

type LocalBinding =
  | { type: 'd1' | 'kv'; id: string }
  | { type: 'r2'; name: string }
  | { type: typeof DURABLE_OBJECT_KIND; worker: string; exportName: string };

function runtimeOptions(
  projectDir: string,
  entries: readonly ResourceManifestEntry[],
  objects: readonly LocalDurableObject[],
): MiniflareOptions {
  const env = Object.fromEntries<LocalBinding>(
    entries.map((entry): [string, LocalBinding] => {
      if (entry.type === DURABLE_OBJECT_TYPE)
        return [
          entry.name,
          {
            type: DURABLE_OBJECT_KIND,
            worker: ownerName(entry.name),
            exportName: DURABLE_OBJECT_EXPORT,
          },
        ];
      const id = `${entry.name}-${WORKER_NAME}`;
      return [
        entry.name,
        entry.type === 'r2_bucket'
          ? { type: 'r2' as const, name: id }
          : { type: RUNTIME_TYPES[entry.type], id },
      ];
    }),
  );
  return {
    resourcePersistencePath: path.join(projectDir, PERSIST_DIR),
    workers: [
      {
        config: {
          name: WORKER_NAME,
          compatibilityDate: COMPATIBILITY_DATE,
          manifest: {
            mainModule: ENTRY_MODULE,
            modules: { [ENTRY_MODULE]: { type: 'esm', contents: ENTRY_SOURCE } },
          },
          // Keep the original default identifiers when the same storage is bound to an owner
          // Worker too; otherwise each owner's constructor would receive a separate database.
          env,
        },
      },
      ...objects.map((object) => {
        return {
          config: {
            name: ownerName(object.declaration.name),
            compatibilityDate: COMPATIBILITY_DATE,
            compatibilityFlags: ['nodejs_compat'],
            manifest: {
              mainModule: ENTRY_MODULE,
              modules: { [ENTRY_MODULE]: { type: 'esm' as const, contents: object.source } },
            },
            exports: {
              [DURABLE_OBJECT_EXPORT]: {
                type: DURABLE_OBJECT_KIND,
                storage: 'sqlite',
              } as const,
            },
            env,
          },
        };
      }),
    ],
  };
}

/** The local runtime, started. Its module is loaded here and not at the top of this one. */
async function startRuntime(options: MiniflareOptions): Promise<Miniflare> {
  // On demand, because what this import brings with it is a runtime binary for this platform. A
  // machine that has none must still be able to run every other thing this CLI does, and a static
  // import would take the whole command down at load time instead of this one feature at use time.
  const { Miniflare } = await import('miniflare');
  return new Miniflare(options);
}

/** The Node-side object for one binding, of whichever kind the manifest says it is. */
async function bindingOf(runtime: Miniflare, entry: ResourceManifestEntry): Promise<unknown> {
  switch (entry.type) {
    case 'd1': {
      return runtime.getD1Database(entry.name);
    }
    case 'kv_namespace': {
      return runtime.getKVNamespace(entry.name);
    }
    case 'r2_bucket': {
      return runtime.getR2Bucket(entry.name);
    }
    case DURABLE_OBJECT_TYPE: {
      return runtime.getDurableObjectNamespace(entry.name, WORKER_NAME);
    }
  }
}

/**
 * A failure this module has already put into words, so that nothing quotes a runtime at a reader.
 */
class LocalStorageError extends Error {
  public override readonly name = 'LocalStorageError';
}

/** The cheapest read there is of one binding: nothing is stored, and nothing is written. */
async function probe(entry: ResourceManifestEntry, binding: unknown): Promise<void> {
  switch (entry.type) {
    case DURABLE_OBJECT_TYPE: {
      // Namespace readiness never constructs an object or executes the customer's class.
      return;
    }
    case 'd1': {
      const database = binding as { prepare: (sql: string) => { first: () => Promise<unknown> } };
      await database.prepare('select 1').first();
      return;
    }
    case 'kv_namespace': {
      await (binding as { get: (key: string) => Promise<unknown> }).get(PROBE_KEY);
      return;
    }
    case 'r2_bucket': {
      await (binding as { head: (key: string) => Promise<unknown> }).head(PROBE_KEY);
    }
  }
}

/** Is that process still running? Signal 0 asks without sending anything. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // `EPERM` is a process this user may not signal, which is still a process that exists.
    return (error as { code?: string }).code === 'EPERM';
  }
}

/** Every run that has said it is using this storage, by the pid each entry is named for. */
async function others(dir: string): Promise<number[]> {
  const entries = await readdir(dir);
  return entries
    .map((entry) => Number.parseInt(entry, 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
}

/**
 * Take this run's entry out, and nothing else.
 *
 * Synchronous, because the one place this has to work is an `exit` handler. Its own name is the only
 * one it ever removes, which is what makes it safe at any moment — including after somebody deleted
 * `.upwind/` underneath a running project, which is how a project is put back to empty.
 */
function letGoOfClaim(mine: string): void {
  try {
    unlinkSync(mine);
  } catch {
    // Gone already. There is nothing to let go of and nobody to tell.
  }
}

/**
 * Say that this run is using the project's storage, or stand down for the run that already is.
 *
 * Written first and read second, and in that order for a reason: a run that reads the directory
 * before writing itself into it can be read as absent by somebody doing the same thing at the same
 * moment, and then both go on. This way the only pair that can miss each other is one that started
 * in the same instant, and what they both do then is stand down — over-cautious once, rather than
 * wrong.
 *
 * Entries naming processes that no longer exist are cleared as they are found. That is safe where
 * taking over a shared claim is not: an entry's name says whose it is, so a run only ever removes
 * its own, and those of processes that hold nothing because they are gone.
 */
async function claimStorage(persist: string): Promise<() => void> {
  const dir = path.join(persist, OWNERS_DIR);
  await mkdir(dir, { recursive: true });
  const mine = path.join(dir, String(process.pid));
  await writeFile(mine, '');
  // Also on the way out, because most of the processes that use storage are not asked to give it
  // back: a build's render worker is ended with a signal, and the runtime's handler for that ends
  // the process from inside. `exit` is the last thing that runs either way, and only a synchronous
  // hand-back is any use there.
  const atExit = (): void => {
    letGoOfClaim(mine);
  };
  process.once('exit', atExit);
  const release = (): void => {
    process.removeListener('exit', atExit);
    letGoOfClaim(mine);
  };
  const live: number[] = [];
  const said = await others(dir);
  for (const pid of said) {
    if (running(pid)) {
      live.push(pid);
      continue;
    }
    try {
      // A process that is gone is using nothing, and the entry's name is what says it was its.
      await unlink(path.join(dir, String(pid)));
    } catch {
      // Somebody else cleared it first, which is the same outcome.
    }
  }
  const [first] = live;
  if (first !== undefined) {
    release();
    throw new LocalStorageError(
      `another process (${String(first)}) is already using this project's local storage (${PERSIST_DIR}/), so nothing is published in this run — a dev server and a build cannot use it at the same time, and neither can two dev servers on the same project. If nothing is using it, delete ${PERSIST_DIR}/${OWNERS_DIR}/`,
    );
  }
  return release;
}

/** A failure once the deadline has passed. Its timer never holds a process open by itself. */
async function afterDeadline(ms: number, said: string): Promise<never> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
  throw new LocalStorageError(said);
}

/**
 * Prove the storage can be read, before a single binding is published.
 *
 * The runtime does not open a database when it starts; it opens it at the first query. So a runtime
 * that cannot reach its storage at all — a directory it has no business in, one whose contents another
 * program left in a state it will not have — is one that looks perfectly well until an application
 * asks it something, and then answers nothing at all. The first read of every kind is made here
 * instead, against a key nothing uses, where a failure is still a sentence this can print and where
 * a read that never answers is caught by the deadline the whole attempt is under (`START_MS`).
 *
 * What this does *not* catch is another runtime over the same directory: two of them read side by
 * side without complaint, and it is the first *write* that dies. `claimStorage` is what covers that,
 * because nothing here could.
 */
async function proveReadable(
  env: FunctionEnv,
  entries: readonly ResourceManifestEntry[],
): Promise<void> {
  await Promise.all(entries.map(async (entry) => probe(entry, env[entry.name])));
}

/**
 * The environment these bindings make up, in the shape a Function's environment is in: each object
 * under the name it is bound to, and the list of them under `ARKOR_RESOURCES`.
 *
 * The long way round on purpose. `resourcesOf` reads that list and picks the bindings out of this
 * object exactly as it does in a deployment, so what an application finds locally came through the
 * same rules — including the rule that a name the list does not carry is not published, whatever
 * else happens to be in here.
 */
async function localEnv(
  runtime: Miniflare,
  entries: readonly ResourceManifestEntry[],
): Promise<FunctionEnv> {
  const env = Object.create(null) as Record<string, unknown>;
  env[RESOURCES_MANIFEST_BINDING] = formatResourcesManifest(entries);
  for (const entry of entries) {
    // An object, as a Function's binding is — which is what `resourcesOf` publishes and what it
    // passes over. The runtime hands these across a socket, and they are objects on this side too.
    env[entry.name] = await bindingOf(runtime, entry);
  }
  return env;
}

/**
 * Stop the runtime, and stop waiting for one that cannot answer.
 *
 * A runtime that died inside a query — `proveReadable` says how that happens — never reports the exit
 * that `dispose` waits for, so a shutdown that simply awaited it would be a process that never ends:
 * in a build's render worker, a build that never ends. Its own exit hook is the backstop, and it is a
 * `SIGKILL`, so whatever this gives up on is still gone when the process leaves.
 */
async function stopRuntime(runtime: Miniflare): Promise<boolean> {
  try {
    await Promise.race([runtime.dispose(), afterDeadline(STOP_MS, 'the runtime did not stop')]);
    return true;
  } catch {
    // Nothing more can be done about it here, and nothing is waiting to be told: a run that is
    // shutting down has nowhere to put this, and one that failed to start has already said so. What
    // the answer is for is the claim, which must not go back while a runtime may still be up.
    return false;
  }
}

function stopper(
  runtime: Miniflare,
  release: () => void,
  watchedFiles: readonly string[],
  sourcesChanged: () => boolean,
): LocalResources {
  let stopping: Promise<void> | undefined;
  return {
    watchedFiles,
    sourcesChanged,
    dispose: async () => {
      // Once, and awaited by everyone: a dev run ends through whichever of its paths reaches the
      // end first, and stopping a runtime that is already stopping is not the caller's problem.
      stopping ??= letGo(Promise.resolve(runtime), release);
      await stopping;
    },
  };
}

/** What there is to say about a run that has no local storage after all. */
function cannotStart(error: unknown): string {
  if (error instanceof LocalStorageError) {
    return `upwind: ${error.message}`;
  }
  const reason = error instanceof Error ? error.message : String(error);
  // The failure worth naming, because it says what to do about it rather than what went wrong: the
  // runtime will not share a directory, so whoever has it has it.
  if (reason.includes('SQLITE_BUSY')) {
    return `upwind: another process is already holding this project's local storage (${PERSIST_DIR}/), so nothing is published in this one — a dev server and a build cannot hold it at the same time, and neither can two dev servers on the same project`;
  }
  // The first line only: a runtime that failed to start says so in pages of its own output, and the
  // sentence that names what was lost must not be at the bottom of them.
  const [first = reason] = reason.split('\n', 1);
  return `upwind: could not start this project's local storage (${first}) — nothing is published, so \`db\`, \`kv()\` and \`blob()\` will find nothing in this run`;
}

interface Attempt {
  /**
   * The runtime, as soon as there is one, or nothing when the attempt failed before there was.
   *
   * Separate from `done` because the two answer at different moments, and the cleanup path needs the
   * earlier one: what the deadline below catches is a query that never answers, and by then a runtime
   * is up and holding the project's storage. Waiting for `done` to find that out would be waiting for
   * the very thing that is not going to happen.
   */
  readonly runtime: Promise<Miniflare | undefined>;
  /** The whole of it: a runtime, the bindings on it, a read through each, and the symbol. */
  readonly done: Promise<Miniflare>;
}

function startAndPublish(
  projectDir: string,
  entries: readonly ResourceManifestEntry[],
  objects: readonly LocalDurableObject[],
): Attempt {
  const arrived: PromiseWithResolvers<Miniflare | undefined> = Promise.withResolvers();
  const done = (async (): Promise<Miniflare> => {
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(runtimeOptions(projectDir, entries, objects));
    } finally {
      // Either way, and before anything slower: a runtime, or the news that there will not be one.
      arrived.resolve(runtime);
    }
    const env = await localEnv(runtime, entries);
    await proveReadable(env, entries);
    publishResources(env);
    return runtime;
  })();
  return { runtime: arrived.promise, done };
}

/**
 * Let go of everything that was taken: the runtime, as soon as there is one to stop, and then the
 * claim on the storage — but only once the runtime is known to be gone.
 *
 * A stop that could not be confirmed leaves the claim where it is, because the claim is what keeps a
 * second runtime out of a directory this one may still be in. Nothing is lost by keeping it: a claim
 * outlives the process that made it only until the next run reads a pid nobody answers to, and this
 * process's own `exit` gives it back for good once the runtime has been killed outright.
 */
async function letGo(
  arriving: Promise<Miniflare | undefined> | undefined,
  release: (() => void) | undefined,
): Promise<void> {
  const runtime = arriving === undefined ? undefined : await arriving;
  const gone = runtime === undefined || (await stopRuntime(runtime));
  if (gone) {
    release?.();
  }
}

/**
 * Start a project's local storage and publish it, or say why there is none.
 *
 * Said and carried on rather than thrown, the way a missing adapter is (`dev/adapter.ts`): a dev
 * server without storage still serves the application, and a build without it still builds
 * everything that does not read storage. What breaks is narrower than the command, and where it
 * breaks the reader is told which of the two happened — this line, and then the SDK's own.
 */
export async function startLocalResources(
  projectDir: string,
  options: LocalOptions,
): Promise<LocalResources> {
  // Before the runtime is started, and given back in the `finally`: what it does to a process it
  // does not own, and why that matters more than it sounds like, is `listeners.ts`.
  const guard = guardListeners({ answersSignals: options.answersSignals });
  let release: (() => void) | undefined;
  let attempt: Attempt | undefined;
  const watchedFiles = new Set<string>();
  const versions = new Map<string, string>();
  let sourcesChanged = noSourceChanges;
  try {
    const objects = await localObjects(projectDir, watchedFiles, versions);
    sourcesChanged = sourceChanges(versions);
    const entries = [
      ...bindings(),
      ...objects.map((object): ResourceManifestEntry => {
        return {
          name: object.declaration.name,
          type: DURABLE_OBJECT_TYPE,
        };
      }),
    ];
    // The claim comes first, because the thing it prevents cannot be undone: two runtimes over one
    // directory read each other's data happily and then lose a write with no error anybody can see.
    release = await claimStorage(path.join(projectDir, PERSIST_DIR));
    attempt = startAndPublish(projectDir, entries, objects);
    const runtime = await Promise.race([
      attempt.done,
      afterDeadline(
        START_MS,
        `this project's local storage did not come up within ${String(START_SECONDS)}s, so nothing is published in this run`,
      ),
    ]);
    return stopper(runtime, release, [...watchedFiles], sourcesChanged);
  } catch (error) {
    console.warn(cannotStart(error));
    // Whatever went wrong, a runtime process must not outlive the attempt that started it — including
    // an attempt still in the middle of starting one — and the claim goes back with it. Nothing waits
    // for that: this run has already said it has no storage, and what is being let go of was never
    // published to anybody.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- said above, not waited for.
    void letGo(attempt?.runtime, release);
    return { ...NOTHING_STARTED, watchedFiles: [...watchedFiles], sourcesChanged };
  } finally {
    guard.restore();
  }
}
