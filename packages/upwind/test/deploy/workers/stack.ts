import {
  convertV4MiniflareOptions,
  Log,
  LogLevel,
  Miniflare,
  type V4WorkerOptions,
  type V4WorkerOptionsShape,
} from 'miniflare';

import { shippedWorkers, type WorkerRole, type WorkerScript } from '../../../src/deploy/shipped.ts';

/**
 * The Workers `upwind deploy` ships, bundled as it ships them, run under Miniflare with the
 * bindings a deploy gives them on an account: what the suites here ask questions of.
 */

export const AGENT_KEY = 'k'.repeat(48);
export const CACHE_TOKEN_KEY = 't'.repeat(64);
const COMPATIBILITY_DATE = '2026-09-15';

/** Bundled once for every suite in a run: bundling is the slow part. */
const bundled: { scripts?: Promise<Record<WorkerRole, WorkerScript>> } = {};

export function workers(): Promise<Record<WorkerRole, WorkerScript>> {
  bundled.scripts ??= shippedWorkers();
  return bundled.scripts;
}

class QuietLog extends Log {
  constructor() {
    super(LogLevel.NONE);
  }
}

function worker(name: string, script: string, rest: V4WorkerOptionsShape): V4WorkerOptions {
  return {
    ...rest,
    name,
    modulesRoot: `/${name}`,
    modules: [{ type: 'ESModule', path: `/${name}/index.mjs`, contents: script }],
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ['nodejs_compat'],
    unsafeDirectSockets: [{ host: '127.0.0.1', proxy: false }],
  };
}

export interface RunningStack {
  readonly mf: Miniflare;
  url(name: string): Promise<URL>;
  dispose(): Promise<void>;
}

/**
 * The agent (twice: one in the mode it deploys in, one destroying), the cache authority it seeds
 * through, and the edge, over one namespace and one bucket, as an account holds them.
 */
export async function runStack(
  options: {
    readonly pointer?: string;
    readonly versionId?: string;
    readonly agentKey?: string;
  } = {},
): Promise<RunningStack> {
  const scripts = await workers();
  const stores = {
    kvNamespaces: { EDGE_STATE: 'edge-state' },
    r2Buckets: { ARTIFACTS: 'artifacts' },
  };
  const agent = (mode: string): V4WorkerOptionsShape => {
    return {
      ...stores,
      bindings: {
        ...(options.agentKey !== '' && { AGENT_KEY: options.agentKey ?? AGENT_KEY }),
        AGENT_MODE: mode,
      },
      serviceBindings: { CACHE_CONTROL: { name: 'cache', entrypoint: 'CacheControl' } },
    };
  };
  const cache = worker('cache', scripts.cache.script, {
    bindings: { CACHE_TOKEN_KEY },
    kvNamespaces: { CACHE_STATE: 'cache-state' },
    r2Buckets: stores.r2Buckets,
    // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's name for the option
    durableObjects: { CACHE_SCOPE: { className: 'CacheScope', useSQLite: true } },
  });
  const edge = worker('edge', scripts.edge.script, {
    kvNamespaces: { EDGE_STATE: 'edge-state', CACHE_STATE: 'cache-state' },
    r2Buckets: stores.r2Buckets,
    bindings: {
      ...(options.pointer !== undefined && { POINTER: options.pointer }),
      // What Cloudflare's version metadata binding holds, which Miniflare does not bind.
      CF_VERSION_METADATA: { id: options.versionId ?? 'version-1', tag: '', timestamp: '' },
    },
  });
  const deploying = worker('agent', scripts.agent.script, agent('deploy'));
  const destroying = worker('agent-destroying', scripts.agent.script, agent('destroy'));
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({ workers: [deploying, destroying, cache, edge] }),
    log: new QuietLog(),
  });
  await mf.ready;
  return {
    mf,
    url: async (name) => new URL((await mf.unsafeGetDirectURL(name)).href),
    dispose: () => mf.dispose(),
  };
}
