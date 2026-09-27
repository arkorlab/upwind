import path from 'node:path';

import {
  formatResourcesManifest,
  type FunctionEnv,
  RESOURCES_MANIFEST_BINDING,
  type ResourceManifestEntry,
  type ResourceType,
} from '@stayingupwind/core/paas';
import type { Miniflare, MiniflareOptions } from 'miniflare';

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
 * `.ppr-cdn`. The runtime keeps a subdirectory per kind under it (`d1/`, `kv/`, `r2/`).
 */
const PERSIST_DIR = '.upwind';

/**
 * One directory of storage, one runtime that may write to it.
 *
 * A second runtime over the same `.upwind/` does not queue behind the first. Reading is fine —
 * several of them can read at once, as several readers of a SQLite database can — but a *write*
 * from the second dies inside the runtime, `SQLITE_BUSY` and fatal, taking the runtime with it and
 * leaving that query unanswered for good. There is nothing to catch, because nothing ever returns.
 *
 * `upwind dev` is one process and never meets this. A build renders in several, so `upwind build`
 * asks the adapter for one (`UPWIND_LOCAL_RESOURCES_ENV`, `experimental.cpus`) and publishes only
 * there (`entry.ts`). A project that sets its own worker count keeps it, and then a prerender that
 * writes is a prerender that may find the storage taken — which is what `proveReadable` and the
 * reader's own message are for.
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
 * Under the two seconds a `upwind dev` supervisor gives a child it has signalled before killing it
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

/** What the local runtime calls each kind of storage the contract names. */
const RUNTIME_TYPES = {
  d1: 'd1',
  kv_namespace: 'kv',
  r2_bucket: 'r2',
} as const satisfies Record<ResourceType, string>;

export interface LocalResources {
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

function runtimeOptions(
  projectDir: string,
  entries: readonly ResourceManifestEntry[],
): MiniflareOptions {
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
          // No identifier per binding: the runtime derives a stable one from the binding name and
          // the worker's, which is what the directories under `.upwind/` are named after.
          env: Object.fromEntries(
            entries.map((entry) => [entry.name, { type: RUNTIME_TYPES[entry.type] }]),
          ),
        },
      },
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
 * The runtime does not open a database when it starts — it opens it at the first query, and a
 * directory another process is already holding is one that query dies on: `SQLITE_BUSY`, fatal,
 * from inside the runtime, taking the runtime with it and leaving the query unanswered for good.
 * Published without this, that would be an application that *hangs* the first time a page reads
 * storage, which is the worst of the ways this can go wrong — nothing to read, and nothing said.
 *
 * So the first read of every kind is made here, against a key nothing uses. What cannot answer is
 * caught by the deadline the whole attempt is under (`START_MS`).
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
  const env: Record<string, unknown> = {
    [RESOURCES_MANIFEST_BINDING]: formatResourcesManifest(entries),
  };
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
async function stopRuntime(runtime: Miniflare): Promise<void> {
  try {
    await Promise.race([runtime.dispose(), afterDeadline(STOP_MS, 'the runtime did not stop')]);
  } catch {
    // Nothing more can be done about it here, and nothing is waiting to be told: a run that is
    // shutting down has nowhere to put this, and one that failed to start has already said so.
  }
}

function stopper(runtime: Miniflare): LocalResources {
  let stopping: Promise<void> | undefined;
  return {
    dispose: async () => {
      // Once, and awaited by everyone: a dev run ends through whichever of its paths reaches the
      // end first, and stopping a runtime that is already stopping is not the caller's problem.
      stopping ??= stopRuntime(runtime);
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

/** What starting takes: a runtime, the bindings on it, a read through each, and the symbol. */
async function startAndPublish(
  started: { runtime?: Miniflare },
  projectDir: string,
  entries: readonly ResourceManifestEntry[],
): Promise<void> {
  // Handed back through the caller's object rather than returned, so that a deadline which gives up
  // on the rest of this still knows what there is to stop.
  started.runtime = await startRuntime(runtimeOptions(projectDir, entries));
  const env = await localEnv(started.runtime, entries);
  await proveReadable(env, entries);
  publishResources(env);
}

/**
 * Stop the runtime an abandoned attempt started, whenever it turns out to have started one.
 *
 * An attempt that lost to the deadline is still running: it may be between `new Miniflare` and the
 * query that proves the storage readable, and the runtime it is about to hold would then be one
 * nothing published and nothing stops. So the attempt is waited out — its failure is already
 * reported, and is not a reason to say anything twice — and whatever it left behind is stopped.
 */
async function stopWhateverStarted(
  attempt: Promise<void>,
  started: { runtime?: Miniflare },
): Promise<void> {
  try {
    await attempt;
  } catch {
    // Reported by the caller, which is the one that gave up on this.
  }
  if (started.runtime !== undefined) {
    await stopRuntime(started.runtime);
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
  const entries = bindings();
  // Before the runtime is started, and given back in the `finally`: what it does to a process it
  // does not own, and why that matters more than it sounds like, is `listeners.ts`.
  const guard = guardListeners({ answersSignals: options.answersSignals });
  const started: { runtime?: Miniflare } = {};
  const attempt = startAndPublish(started, projectDir, entries);
  try {
    await Promise.race([
      attempt,
      afterDeadline(
        START_MS,
        `this project's local storage did not come up within ${String(START_SECONDS)}s, so nothing is published in this run — another process holding it (${PERSIST_DIR}/) is the usual reason`,
      ),
    ]);
    // Only reached when `startAndPublish` won, so the runtime is there.
    return started.runtime === undefined ? NOTHING_STARTED : stopper(started.runtime);
  } catch (error) {
    console.warn(cannotStart(error));
    // Whatever went wrong, a runtime process must not outlive the attempt that started it — and an
    // attempt this gave up on may still be starting one, so it is followed to wherever it ends and
    // whatever it left is stopped. Nothing waits for that: this run has already said it has no
    // storage, and the runtime it is stopping was never published to anybody.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- said above, not waited for.
    void stopWhateverStarted(attempt, started);
    return NOTHING_STARTED;
  } finally {
    guard.restore();
  }
}
