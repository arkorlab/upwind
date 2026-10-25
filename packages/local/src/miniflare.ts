import {
  convertV4MiniflareOptions,
  Log,
  LogLevel,
  Miniflare,
  type V4WorkerOptions,
} from 'miniflare';

/**
 * Every call this package makes on Miniflare, whose API is an alpha: the Workers of a stack in the
 * stack's own terms, run in one instance, and the direct sockets the stack is reached over. A
 * response over a direct socket streams as the Worker writes it; Miniflare's own entry hands one
 * back whole, which would put every first byte at the last.
 */

const IPV4_LOOPBACK = '127.0.0.1';

export type ModuleType = 'ESModule' | 'CommonJS' | 'Text' | 'Data' | 'CompiledWasm';

export interface LocalModule {
  readonly type: ModuleType;
  /** Its name in the Worker, which other modules import it by. */
  readonly name: string;
  readonly contents: string | Uint8Array;
}

/** Another Worker of the stack: its default entrypoint, or the one named. */
type LocalService =
  | string
  | {
      readonly name: string;
      readonly entrypoint?: string;
      readonly props?: Readonly<Record<string, unknown>>;
    };

/** One Worker of a stack. */
export interface LocalWorker {
  readonly name: string;
  /** The first is the main module. */
  readonly modules: readonly LocalModule[];
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[] | undefined;
  readonly bindings?: Readonly<Record<string, string>> | undefined;
  readonly services?: Readonly<Record<string, LocalService>> | undefined;
  /** The Worker of the stack what this one fetches itself goes to, where not the network. */
  readonly outbound?: string | undefined;
  /** Each KV namespace and bucket by the id the stack keeps it under: one id, one store. */
  readonly kvNamespaces?: Readonly<Record<string, string>> | undefined;
  readonly r2Buckets?: Readonly<Record<string, string>> | undefined;
  readonly d1Databases?: Readonly<Record<string, string>> | undefined;
  /** Each namespace by the class the Worker exports, kept in SQLite. */
  readonly durableObjects?: Readonly<Record<string, string>> | undefined;
  /**
   * The name of an Images binding, transforming on this machine — Miniflare's own, which resizes
   * and encodes with `sharp` — rather than by Cloudflare Images.
   */
  readonly images?: string | undefined;
  /**
   * Reached from outside the stack: on these addresses (the IPv4 loopback, when it names none), at
   * this port on each, or on a free one when it names none.
   */
  readonly socket?:
    | { readonly port?: number | undefined; readonly hosts?: readonly string[] | undefined }
    | undefined;
  /**
   * Entrypoints the Worker exports that are reached from outside the stack too, each on a socket of
   * its own on the IPv4 loopback, at a free port: what the stack itself speaks to, apart from
   * anything the Worker serves on `socket`.
   */
  readonly entrypointSockets?: readonly string[] | undefined;
}

export interface RunningWorkers {
  /**
   * Where a Worker given a socket is reached: at the first of its addresses — or an entrypoint of it
   * given one of its own (`LocalWorker.entrypointSockets`).
   */
  url(name: string, entrypoint?: string): Promise<URL>;
  dispose(): Promise<void>;
}

/** Who stops the stack on a signal: Miniflare, which exits at once, or the caller. */
export type SignalHandling = 'miniflare' | 'caller';

/**
 * The signals Miniflare stops its runtime and exits the process on, each by the name its exit hook
 * gives its handler of it (`exit-hook.ts` in Miniflare).
 */
const MINIFLARE_HANDLERS: ReadonlyMap<NodeJS.Signals, string> = new Map([
  ['SIGHUP', 'onSignalHup'],
  ['SIGINT', 'onSignalInt'],
  ['SIGTERM', 'onSignalTerm'],
]);
/** What Miniflare's exit hook handles the process's exit with, while any instance holds it. */
const MINIFLARE_EXIT_HANDLER = 'onExit';
/** What each of the hook's handlers runs, which a handler of another's of the same name does not. */
const MINIFLARE_HOOK_CALL = 'runCallbacks()';

/**
 * Whether `listener` is the handler Miniflare's exit hook calls `name`: of that name, and running
 * the hook's callbacks (`exit-hook.ts`) — not a caller's own of the same name, which is the
 * caller's to keep. A Miniflare whose hook reads otherwise is held to none: its handler then stays,
 * and exits on the signal as it would for a stack whose caller does not handle them.
 */
function isMiniflareHandler(listener: (...args: never[]) => unknown, name: string): boolean {
  return (
    listener.name === name &&
    Function.prototype.toString.call(listener).includes(MINIFLARE_HOOK_CALL)
  );
}

/**
 * Miniflare's handlers of the stopping signals, held aside while any stack whose caller handles
 * them runs. They are one set for the process, whatever runs in it: Miniflare's exit hook puts them
 * on the process for the first instance and takes them off after the last, every instance in
 * between only joining them. So what one instance's construction added says nothing of what another
 * relies on: they are taken off as the hook's (`isMiniflareHandler`), for as long as a caller handles
 * the signals, and put back after the last such stack where Miniflare's hook still holds the
 * process (its exit handler).
 */
const callerHandled: { stacks: number; held: Map<NodeJS.Signals, NodeJS.SignalsListener> } = {
  stacks: 0,
  held: new Map(),
};

/** Miniflare's handlers of the stopping signals taken off the process, and kept to be put back. */
function holdMiniflareHandlers(): void {
  for (const [signal, name] of MINIFLARE_HANDLERS) {
    for (const listener of process.listeners(signal)) {
      if (isMiniflareHandler(listener, name)) {
        process.removeListener(signal, listener);
        callerHandled.held.set(signal, listener);
      }
    }
  }
}

/**
 * Whether Miniflare's exit hook is where a stack whose caller handles the signals finds it: each of
 * its handlers on the process, or held aside by such a stack already. Found by what Miniflare's own
 * code is (`isMiniflareHandler`) — so a Miniflare whose hook reads otherwise is found by none, and
 * said so (`MISSING_HOOK`), rather than left to exit the process on a signal unannounced.
 */
export function miniflareHookFound(): boolean {
  return [...MINIFLARE_HANDLERS].every(([signal, name]) => {
    return (
      callerHandled.held.has(signal) ||
      process.listeners(signal).some((listener) => isMiniflareHandler(listener, name))
    );
  });
}

/** What a stack whose caller handles the signals says where it finds no exit hook of Miniflare's. */
const MISSING_HOOK =
  "Miniflare's exit hook was not found: a signal exits the process at once, before the stack is disposed";

/** A stack whose caller handles the signals gone: after the last, Miniflare's put back. */
function releaseMiniflareHandlers(): void {
  callerHandled.stacks -= 1;
  if (callerHandled.stacks > 0) {
    return;
  }
  const hooked = process
    .listeners('exit')
    .some((listener) => isMiniflareHandler(listener, MINIFLARE_EXIT_HANDLER));
  for (const [signal, listener] of callerHandled.held) {
    if (hooked && !process.listeners(signal).includes(listener)) {
      process.on(signal, listener);
    }
  }
  callerHandled.held.clear();
}

/** Nothing of Miniflare's own; what the Workers log goes to the caller. */
class QuietLog extends Log {
  constructor() {
    super(LogLevel.NONE);
  }
}

type DurableObjectOptions = NonNullable<V4WorkerOptions['durableObjects']>;

/** The namespaces as Miniflare takes them: each by the class the Worker exports, kept in SQLite. */
function durableObjectOptions(
  declared: Readonly<Record<string, string>> = {},
): DurableObjectOptions {
  const options: DurableObjectOptions = {};
  for (const [binding, exported] of Object.entries(declared)) {
    // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
    options[binding] = { className: exported, useSQLite: true };
  }
  return options;
}

function v4Options(worker: LocalWorker): V4WorkerOptions {
  const { socket } = worker;
  const sockets = [
    ...(socket === undefined
      ? []
      : (socket.hosts ?? [IPV4_LOOPBACK]).map((host) => {
          return {
            host,
            ...(socket.port !== undefined && { port: socket.port }),
            proxy: false,
          };
        })),
    ...(worker.entrypointSockets ?? []).map((entrypoint) => {
      return {
        host: IPV4_LOOPBACK,
        entrypoint,
        proxy: false,
      };
    }),
  ];
  return {
    name: worker.name,
    modulesRoot: `/${worker.name}`,
    modules: worker.modules.map((module) => {
      return {
        type: module.type,
        path: `/${worker.name}/${module.name}`,
        contents: module.contents,
      };
    }),
    compatibilityDate: worker.compatibilityDate,
    compatibilityFlags: [...(worker.compatibilityFlags ?? [])],
    bindings: { ...worker.bindings },
    serviceBindings: { ...worker.services },
    ...(worker.outbound !== undefined && { outboundService: worker.outbound }),
    kvNamespaces: { ...worker.kvNamespaces },
    r2Buckets: { ...worker.r2Buckets },
    d1Databases: { ...worker.d1Databases },
    durableObjects: durableObjectOptions(worker.durableObjects),
    ...(worker.images !== undefined && { images: { binding: worker.images } }),
    ...(sockets.length > 0 && { unsafeDirectSockets: sockets }),
  };
}

/**
 * The Workers, up in one Miniflare, with what they log handed to `log`. A caller that handles the
 * stopping signals itself (`signals: 'caller'`) is left the only one that does while the stack
 * runs (`callerHandled`): Miniflare's own handler exits the process at once, before a caller's
 * could dispose the stack and say so.
 */
export async function runWorkers(
  workers: readonly LocalWorker[],
  log: (message: string) => void,
  signals: SignalHandling = 'miniflare',
): Promise<RunningWorkers> {
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({ workers: workers.map((worker) => v4Options(worker)) }),
    log: new QuietLog(),
    handleStructuredLogs: (entry) => {
      log(entry.message);
    },
  });
  // Miniflare puts its handlers on the process as it is constructed (`exitHook`, from its
  // constructor) — the first instance's, or again after the last was disposed — so they are held
  // aside once it returns, by any stack while a caller handles the signals.
  if (signals === 'caller') {
    callerHandled.stacks += 1;
  }
  if (callerHandled.stacks > 0) {
    holdMiniflareHandlers();
  }
  // Once, however often it is asked for: a stack let go of twice is one fewer whose caller handles
  // the signals, not two, which would hand them back while another such stack still runs.
  const disposal: { done?: Promise<void> } = {};
  const dispose = (): Promise<void> => {
    disposal.done ??= (async (): Promise<void> => {
      try {
        await mf.dispose();
      } finally {
        if (signals === 'caller') {
          releaseMiniflareHandlers();
        }
      }
    })();
    return disposal.done;
  };
  // Said where a caller's own `log` may throw, which lets the stack go as a failed start does.
  try {
    if (signals === 'caller' && !miniflareHookFound()) {
      log(MISSING_HOOK);
    }
    await mf.ready;
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    url: (name, entrypoint) => mf.unsafeGetDirectURL(name, entrypoint),
    dispose,
  };
}
