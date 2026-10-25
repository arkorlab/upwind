import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STANDALONE_NAMING } from '@stayingupwind/cache/standalone/naming';
import {
  type DeploymentBundle,
  deploymentBundleSchema,
  PRIMARY_FUNCTION,
} from '@stayingupwind/core/bundle';
import type { AppRuntime, ProjectManifest } from '@stayingupwind/core/manifest';
import {
  formatResourcesManifest,
  RESOURCE_CHANGES_SERVICE_BINDING,
  RESOURCES_MANIFEST_BINDING,
  type ResourceManifestEntry,
  type ResourceType,
} from '@stayingupwind/core/paas';
import { compareCodeUnits } from '@stayingupwind/core/util';
import { functionBindings, type TextBinding } from '@stayingupwind/deploy/bindings';
import { deployBundle } from '@stayingupwind/deploy/deploy';
import { prefetchBlobsOf } from '@stayingupwind/deploy/prefetch';
import {
  CACHE_GATEWAY_URL_BINDING,
  CACHE_READ_GATEWAY_URL_BINDING,
  CACHE_READ_SERVICE_BINDING,
  CACHE_SERVICE_BINDING,
  CACHE_TOKEN_BINDING,
  DEPLOYMENT_ID_BINDING,
  functionBinding,
  PREFETCH_SERVICE_BINDING,
  RESPONSE_CACHE_TTL_BINDING,
  RUNTIME_BINDING,
} from '@stayingupwind/host/bindings';
import { signCacheToken } from '@stayingupwind/host/cache';
import {
  builtinDeliveryPolicy,
  type CspNonceMode,
  DEFAULT_DELIVERY_POLICY,
  type DeliveryPolicy,
  deliveryPolicySchema,
  PLATFORM_POLICY_ID_PATTERN,
} from '@stayingupwind/host/delivery';
import { recoveryScriptCspSource } from '@stayingupwind/host/splice';
import { kvPolicyKey } from '@stayingupwind/host/storage';

import { assertHostOnly, bundleWorker } from './bundle.ts';
import { deploymentFunctions, type FunctionStores } from './functions.ts';
import { gateServices, type LocalGate } from './gates.ts';
import { type LocalWorker, runWorkers, type SignalHandling } from './miniflare.ts';
import { type Loopback, loopbackFor } from './ports.ts';
import { LOCAL_PORT_BINDING, requestedRuntimePort, runtimePortBinding } from './runtime-port.ts';
import { agentTarget } from './target.ts';
import { BACKSTAGE_ENTRYPOINT } from './workers/protocol.ts';

/**
 * A build served on this machine as it is served deployed: the standalone edge in front, the
 * runtime cache's authority and read gateway, the prefetch Worker, and the build's Functions bound
 * as a deploy binds them — all under one Miniflare, over stores the stack alone holds, gone when it
 * is disposed. The build is deployed to it by the same assembly whatever deploys it uses
 * (`deployBundle`), so the manifest the edge serves by is the one a deployment of it would have.
 */

/** The Workers of a stack, by the name each runs as. */
const WORKERS = {
  edge: 'upwind-edge',
  cache: 'upwind-cache',
  cacheRead: 'upwind-cache-read',
  prefetch: 'upwind-prefetch',
  agent: 'upwind-deploy-agent',
  outbound: 'upwind-outbound',
} as const;

/** One of each store, shared among the Workers as a host shares them. */
const STORES = { edgeState: 'edge-state', cacheState: 'cache-state', artifacts: 'artifacts' };

/** The date the stack's own Workers run at; each Function keeps the one its build gave it. */
const COMPATIBILITY_DATE = '2026-09-15';
/** HTTP's default port is absent from the stack URL's host. */
const HTTP_DEFAULT_PORT = 80;
/**
 * What the site is served as. Next.js names every loopback address `localhost` in what it builds
 * (`NextURL`), so a rewrite to the application's own pages comes back under this name whatever
 * address the request came in on.
 */
const HOSTNAME = 'localhost';
/**
 * Every name the host's contract gives a Function's environment, and the local listening PORT,
 * whether or not this stack binds it: the runtime reads each as the host's own, so an application's
 * variable of one of these names is never handed to its Functions — as a deploy hands none of them
 * on. A name a particular host binds beyond this list stays the application's here, as it would
 * on any other host.
 */
const HOST_NAMES: readonly string[] = [
  CACHE_SERVICE_BINDING,
  CACHE_READ_SERVICE_BINDING,
  CACHE_GATEWAY_URL_BINDING,
  CACHE_READ_GATEWAY_URL_BINDING,
  CACHE_TOKEN_BINDING,
  RESPONSE_CACHE_TTL_BINDING,
  DEPLOYMENT_ID_BINDING,
  RUNTIME_BINDING,
  PREFETCH_SERVICE_BINDING,
  RESOURCE_CHANGES_SERVICE_BINDING,
  RESOURCES_MANIFEST_BINDING,
  LOCAL_PORT_BINDING,
];
/** Where the edge reads its pointer in `EDGE_STATE`. */
const POINTER_KEY = 'pointer';
/** The edge's Images binding, by the name a deployed standalone edge reads it under. */
const IMAGES_BINDING = 'IMAGES';
const PROJECT_ID = 'local';
const RUN_ID = 'run_local';
const OWNER = 'local';

export interface StackOptions {
  /** Where the build left its bundle: `bundle.json`, and the blobs it names under `blobs/`. */
  readonly bundleDir: string;
  /** The port the site is served on; otherwise env.PORT, or a free one when neither names one. */
  readonly port?: number | undefined;
  /**
   * The hostnames a check names the site by besides the edge's socket (`CheckOptions.hostname`):
   * what a Function fetches of the site under one goes to the edge, not out to the real host, and
   * the edge takes each for a name of its own, as one deployed does every name it is routed.
   */
  readonly hostnames?: readonly string[] | undefined;
  /**
   * The application's own environment. PORT is a listening-port request, overridden by port;
   * Functions always receive the actual allocated port beside the deployment's bindings.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /**
   * The application's own stores, by the names its Functions bind them under: a host binds a
   * project's KV namespaces, buckets and databases from what the project asks of it, which a build
   * does not carry, so a stack is told them. Each is the stack's own, empty, and gone with it.
   */
  readonly storage?: LocalStorage | undefined;
  /** Where what the Workers log goes; nowhere when this names nothing. */
  readonly log?: ((message: string) => void) | undefined;
  /**
   * Who stops the stack on `SIGINT`, `SIGTERM` and `SIGHUP`: Miniflare by default, which exits the
   * process at once, or the caller, which disposes the stack itself and exits when it is done.
   */
  readonly signals?: SignalHandling | undefined;
  /**
   * What the edge delivers the deployment under (`DeliveryPolicy`): its backends, holds and
   * lifetimes. The default of the day when this names none; a deployment a stack stands in for
   * names the one it went live under — one retired since, or one registered for it — as its
   * pointer does, and is served by it.
   */
  readonly policy?: DeliveryPolicy | undefined;
  /** The site's opt-in to a nonce the edge mints for each document (`EdgePointer.cspNonce`). */
  readonly cspNonce?: CspNonceSetting | undefined;
  /**
   * The gates the build's routes are asked of (`gates`, in its bundle), by name, and where each
   * answers: the edge is bound to each as a deployed edge is, and a request it asks a gate is sent
   * on to the gate's URL from Node (`gateForwarder`). A gate the build declares that this does not
   * name is one the edge is bound to none of: every request of its routes is answered that the gate
   * is unavailable. A configured name absent from the loaded build is refused before workers start.
   */
  readonly gates?: Readonly<Record<string, LocalGate>> | undefined;
  /**
   * Whether the edge transforms what `/_next/image` asks for, as an edge a host binds Cloudflare
   * Images to does (`IMAGES`): on this machine, by Miniflare's Images binding. Without it, the edge
   * answers each image as it is.
   */
  readonly images?: boolean | undefined;
  /**
   * The stack's own Workers, bundled ahead of time (`bundleStackScripts`), for a command that runs
   * where upwind's sources are not; bundled from the sources as the stack starts when this names
   * none.
   */
  readonly scripts?: StackScripts | undefined;
}

/** A site's nonce setting, as a deployment's pointer carries it (`cspNoncePointerFields`). */
export interface CspNonceSetting {
  /** Whether the nonce goes into the enforcing policy, or into a reporting copy of it. */
  readonly mode: CspNonceMode;
  /** Whether `'strict-dynamic'` goes beside it, in each directive governing scripts. */
  readonly strictDynamic: boolean;
}

export interface LocalStorage {
  readonly kv?: readonly string[] | undefined;
  readonly r2?: readonly string[] | undefined;
  readonly d1?: readonly string[] | undefined;
}

export interface LocalStack {
  /** Where the site is served: `http://localhost:<port>/`. */
  readonly url: URL;
  /**
   * Origins registered with the edge and outbound router. A custom stack without this account
   * proves only its socket's checked origin, not additional check hostnames.
   */
  readonly siteOrigins?: readonly string[] | undefined;
  /**
   * The app Functions, by the names the build gives them (`app`, `app-2`, …): each asked on the
   * backstage as a deployment's validation asks each through its edge.
   */
  readonly functions: readonly string[];
  /**
   * The stack's backstage (`workers/protocol.ts`): a socket of the edge's own, which serves no site,
   * where what the edge did for a traced request is read back, and each app Function is asked as
   * the edge routes a validation's probe of one.
   */
  readonly backstage: URL;
  /** Where the build it serves left its bundle. */
  readonly bundleDir: string;
  /** The bundle it holds, as the stack deployed it: what the manifest does not say of the build. */
  readonly bundle: DeploymentBundle;
  readonly deploymentId: string;
  /** The manifest the edge serves the deployment by. */
  readonly manifest: ProjectManifest;
  /**
   * The deployment's Functions as the stack runs them (`deploymentFunctions`): the first by its
   * script, each split one by its name, the middleware's — what the manifest has to name each as.
   */
  readonly app: AppRuntime;
  /** The policy and the nonce setting the deployment's pointer names, as the stack was given them. */
  readonly policy: DeliveryPolicy;
  readonly cspNonce: CspNonceSetting | undefined;
  dispose(): Promise<void>;
}

function local(file: string): string {
  return fileURLToPath(new URL(file, import.meta.url));
}

function resolved(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

/** A Worker's script, refused if it bundles anything but upwind's own and its dependencies. */
async function scriptOf(entry: string): Promise<string> {
  const worker = await bundleWorker(entry);
  assertHostOnly(worker);
  return worker.script;
}

/**
 * The stack's own Workers, each one ES module: what runs beside the build's Functions. All six or
 * none, since each is found where upwind's sources are, and a command run from anywhere else has
 * none of them to bundle.
 */
export interface StackScripts {
  readonly edge: string;
  readonly cache: string;
  readonly cacheRead: string;
  readonly prefetch: string;
  readonly agent: string;
  readonly outbound: string;
}

/**
 * The stack's own Workers, bundled from upwind's sources as `startStack` bundles them when it is
 * given none — for a command that ships them bundled, to run once where it is built.
 */
export async function bundleStackScripts(): Promise<StackScripts> {
  const [edge, cache, cacheRead, prefetch, agent, outbound] = await Promise.all([
    scriptOf(local('workers/edge.ts')),
    scriptOf(resolved('@stayingupwind/cache/standalone/worker')),
    scriptOf(resolved('@stayingupwind/cache/standalone/read-worker')),
    scriptOf(resolved('@stayingupwind/cache/prefetch-worker')),
    scriptOf(local('workers/agent.ts')),
    scriptOf(local('workers/outbound.ts')),
  ]);
  return { edge, cache, cacheRead, prefetch, agent, outbound };
}

function scriptWorker(name: string, script: string): LocalWorker {
  return {
    name,
    modules: [{ type: 'ESModule', name: 'index.mjs', contents: script }],
    compatibilityDate: COMPATIBILITY_DATE,
  };
}

/** The stores a stack keeps for the application, and the list a deploy binds beside them. */
interface Stores {
  readonly stores: FunctionStores;
  /** `ARKOR_RESOURCES`, as a deploy writes it; none where the application asked for no store. */
  readonly manifest: TextBinding | undefined;
}

/**
 * The stores a stack keeps for the application, each binding by its own store's id, and listed
 * under `ARKOR_RESOURCES` as a deploy lists them — by name — for the runtime to publish to the
 * application. A name a deploy binds itself, or one asked for twice, is refused: a binding is one
 * thing.
 */
function storesOf(storage: LocalStorage | undefined, reserved: ReadonlySet<string>): Stores {
  const taken = new Set(reserved);
  const listed: ResourceManifestEntry[] = [];
  // As entries, each made the record's own: a name such as `__proto__` is a binding like any other.
  const kind = (
    names: readonly string[] | undefined,
    type: ResourceType,
    prefix: string,
  ): Record<string, string> => {
    if (names === undefined) {
      return {};
    }
    const stores: [string, string][] = [];
    for (const name of names) {
      if (taken.has(name)) {
        throw new Error(`${name} cannot be bound to a store: the name is already taken`);
      }
      taken.add(name);
      listed.push({ name, type });
      stores.push([name, `${prefix}-${name}`]);
    }
    return Object.fromEntries(stores);
  };
  const stores = {
    kvNamespaces: kind(storage?.kv, 'kv_namespace', 'app-kv'),
    r2Buckets: kind(storage?.r2, 'r2_bucket', 'app-r2'),
    d1Databases: kind(storage?.d1, 'd1', 'app-d1'),
  };
  const ordered = listed.toSorted((a, b) => compareCodeUnits(a.name, b.name));
  return {
    stores,
    manifest:
      ordered.length === 0
        ? undefined
        : {
            name: RESOURCES_MANIFEST_BINDING,
            value: formatResourcesManifest(ordered),
            secret: false,
          },
  };
}

/** The names a stack's site goes by, as its Workers are told them, each list comma-separated. */
export interface SiteNames {
  /**
   * Every hostname the site is reached by (`HOSTNAMES`): `localhost`, each loopback address the edge
   * listens on, as a URL writes it, and each hostname a check names it by — what `next/image` must
   * not fetch a source from, nor follow a redirect to, which would be the edge fetching from itself.
   */
  readonly hostnames: string;
  /**
   * Every origin a request for the site may name (`SITE_ORIGINS`, `workers/outbound.ts`): each name
   * the site is served under, at the edge's port, over HTTP as a browser asks and over HTTPS as a
   * check says it asks (`originOf` in `workers/edge.ts`), and each name a check names it by.
   */
  readonly origins: string;
}

/**
 * The names the site goes by (`SiteNames`), each origin as a URL writes it — `https://localhost:443`
 * as `https://localhost`: those of the edge's socket, and each hostname a check names it by
 * (`StackOptions.hostnames`), as requests for the site name it over HTTP and HTTPS (`siteOf` in
 * `check.ts`) — `example.com:443` as `example.com`.
 */
export function siteNamesOf(socket: Loopback, hostnames: readonly string[]): SiteNames {
  const served = [
    HOSTNAME,
    ...socket.hosts.map((host) => (host.includes(':') ? `[${host}]` : host)),
  ];
  const aliases = hostnames.map((hostname) => new URL(`https://${hostname}/`));
  const port = String(socket.port);
  const origins = [
    ...served.flatMap((name) =>
      ['http', 'https'].map((scheme) => new URL(`${scheme}://${name}:${port}/`).origin),
    ),
    // An HTTP default port is absent from stack.url.host, which the check names over HTTPS.
    ...(socket.port === HTTP_DEFAULT_PORT
      ? served.map((name) => new URL(`https://${name}/`).origin)
      : []),
    ...aliases.map((alias) => alias.origin),
    ...hostnames.flatMap((hostname) => {
      const plain = new URL(`http://${hostname}/`).origin;
      const checked = new URL(`https://${hostname}/`);
      checked.protocol = 'http:';
      return plain === checked.origin ? [plain] : [plain, checked.origin];
    }),
  ];
  return {
    hostnames: [...served, ...aliases.map((alias) => alias.hostname)].join(','),
    origins: origins.join(','),
  };
}

function ignore(): void {
  // Nothing asked to read what the Workers log.
}

/**
 * The site at the edge's socket, under the name it is served as: the socket's scheme and port — none
 * written where it is the scheme's own (`80`), which a URL leaves out.
 */
export function siteUrlOf(socket: URL): URL {
  const site = new URL('/', socket);
  site.hostname = HOSTNAME;
  return site;
}

/**
 * Why a stack's edge cannot deliver by `policy` as a host would: one under the id of a built-in
 * policy, or under one the built-ins take (`PLATFORM_POLICY_ID_PATTERN`), that is not that
 * built-in — no registration may hold such an id, so no deployment goes live under such a policy —
 * or one that reads shells from a Static Assets binding, which a stack binds none of.
 */
export function deliveryPolicyRefusal(policy: DeliveryPolicy): string | undefined {
  const builtin = builtinDeliveryPolicy(policy.id);
  if (
    builtin === undefined
      ? PLATFORM_POLICY_ID_PATTERN.test(policy.id)
      : !isSamePolicy(builtin, policy)
  ) {
    return `${policy.id} is an id the built-in policies hold, which no other policy may`;
  }
  return policy.shell.backend === 'static-assets'
    ? `${policy.id} serves shells from a Static Assets binding, and a stack binds none`
    : undefined;
}

/** Whether two policies say the same, as their schema writes them. */
function isSamePolicy(one: DeliveryPolicy, other: DeliveryPolicy): boolean {
  return (
    JSON.stringify(deliveryPolicySchema.parse(one)) ===
    JSON.stringify(deliveryPolicySchema.parse(other))
  );
}

/** The policy a stack's edge delivers by, as a host would accept it (`deliveryPolicyRefusal`). */
function policyOf(asked: DeliveryPolicy | undefined): DeliveryPolicy {
  const policy = deliveryPolicySchema.parse(asked ?? DEFAULT_DELIVERY_POLICY);
  const refused = deliveryPolicyRefusal(policy);
  if (refused !== undefined) {
    throw new Error(refused);
  }
  return policy;
}

/** Start a stack, and deploy the build in `options.bundleDir` to it. */
export async function startStack(options: StackOptions): Promise<LocalStack> {
  const { bundleDir, cspNonce } = options;
  const askedPort = requestedRuntimePort(options.port, options.env);
  const policy = policyOf(options.policy);
  const json = await readFile(path.join(bundleDir, 'bundle.json'), 'utf8');
  const bundle = deploymentBundleSchema.parse(JSON.parse(json));
  const { deploymentId } = bundle;
  // Refused before anything starts: a name no build declares, an address that is no URL.
  const gates = gateServices(options.gates, new Set(Object.values(bundle.gates ?? {})));
  // A key of the stack's own, gone with it: what the scope's token is signed with.
  const cacheTokenKey = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const token = await signCacheToken(cacheTokenKey, deploymentId, STANDALONE_NAMING);
  const { edge, cache, cacheRead, prefetch, agent, outbound } =
    options.scripts ?? (await bundleStackScripts());
  const bound = functionBindings({
    deploymentId,
    prefetch: WORKERS.prefetch,
    prefetchBlobs: prefetchBlobsOf(bundle),
    cache: {
      gateway: { kind: 'service', service: WORKERS.cache },
      readGateway: { kind: 'service', service: WORKERS.cacheRead },
      token,
    },
  });
  // No receiver for what the Functions write to the application's stores
  // (`RESOURCE_CHANGES_SERVICE_BINDING`): the runtime leaves such a change to Next.js's ordinary
  // invalidation where its host binds none (`reportResourceChange`), which this stack's cache takes.
  const services = bound.services;
  // A name the deploy binds itself is the deploy's: an application's variable of the same name
  // yields to it, as it does deployed, rather than standing beside a binding of another kind. So do
  // the names the host's contract keeps whether or not this stack binds them (`HOST_NAMES`): the
  // gateways' URLs beside their bindings would give the runtime a second way to the cache, and a
  // receiver of storage changes the stack binds none of would be a string the runtime calls.
  const reserved = new Set(HOST_NAMES);
  for (const { name } of bound.text) {
    reserved.add(name);
  }
  for (const { name } of services) {
    reserved.add(name);
  }
  const own = Object.entries(options.env ?? {}).filter(([name]) => !reserved.has(name));
  const named = new Set(reserved);
  for (const [name] of own) {
    named.add(name);
  }
  const { stores, manifest } = storesOf(options.storage, named);
  const socket = await loopbackFor(askedPort);
  const functions = deploymentFunctions(bundleDir, bundle, {
    text: [
      ...own.map(([name, value]) => ({ name, value, secret: false })),
      ...bound.text,
      runtimePortBinding(socket),
      ...(manifest === undefined ? [] : [manifest]),
    ],
    services,
    stores,
    workflowText: own.map(([name, value]) => ({ name, value, secret: false })),
  });
  const names = siteNamesOf(socket, options.hostnames ?? []);
  const workers: LocalWorker[] = [
    {
      ...scriptWorker(WORKERS.edge, edge),
      // Live compression reads `node:zlib`, which the runtime has under this flag.
      compatibilityFlags: ['nodejs_compat'],
      // Each name the site is reached by, a check's among them, as a deployed edge lists its own.
      bindings: { HOSTNAMES: names.hostnames, POINTER_KEY },
      kvNamespaces: { EDGE_STATE: STORES.edgeState, CACHE_STATE: STORES.cacheState },
      r2Buckets: { ARTIFACTS: STORES.artifacts },
      ...(options.images === true && { images: IMAGES_BINDING }),
      services: {
        ...Object.fromEntries(
          functions.workers.map((worker) => [functionBinding(worker.name), worker.name]),
        ),
        // Where a scope stands, so an invalidation reaches the edge within a moment, as deployed.
        CACHE_SIGNALS: { name: WORKERS.cache, entrypoint: 'CacheSignals' },
      },
      // Each gate the stack was told of, under the name a deployed edge binds it by.
      handlers: gates,
      socket,
      entrypointSockets: [BACKSTAGE_ENTRYPOINT],
    },
    {
      ...scriptWorker(WORKERS.outbound, outbound),
      bindings: { SITE_ORIGINS: names.origins },
      services: { EDGE: WORKERS.edge },
    },
    {
      ...scriptWorker(WORKERS.cache, cache),
      bindings: { CACHE_TOKEN_KEY: cacheTokenKey },
      kvNamespaces: { CACHE_STATE: STORES.cacheState },
      r2Buckets: { ARTIFACTS: STORES.artifacts },
      durableObjects: { CACHE_SCOPE: 'CacheScope' },
    },
    {
      ...scriptWorker(WORKERS.cacheRead, cacheRead),
      bindings: { CACHE_TOKEN_KEY: cacheTokenKey },
      kvNamespaces: { CACHE_STATE: STORES.cacheState },
    },
    { ...scriptWorker(WORKERS.prefetch, prefetch), r2Buckets: { ARTIFACTS: STORES.artifacts } },
    {
      ...scriptWorker(WORKERS.agent, agent),
      kvNamespaces: { EDGE_STATE: STORES.edgeState },
      r2Buckets: { ARTIFACTS: STORES.artifacts },
      services: { CACHE_CONTROL: { name: WORKERS.cache, entrypoint: 'CacheControl' } },
      socket: {},
    },
    // What each Function fetches itself, the site's own pages among it, through the router.
    ...functions.workers.map((worker) => ({ ...worker, outbound: WORKERS.outbound })),
    ...(functions.backgroundWorkers ?? []).map((worker) => {
      return {
        ...worker,
        outbound: WORKERS.outbound,
      };
    }),
  ];
  const running = await runWorkers(workers, options.log ?? ignore, options.signals);
  try {
    const target = agentTarget(await running.url(WORKERS.agent), bundleDir);
    // A policy is published by whatever deploys, once, before any pointer names it.
    await target.edgeState.put(kvPolicyKey(policy.id), JSON.stringify(policy));
    const { staged, pointer } = await deployBundle(target, {
      bundle,
      json,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      originHost: HOSTNAME,
      environment: 'production',
      owner: OWNER,
      app: functions.app,
      recoverySource: await recoveryScriptCspSource(),
      policy,
      ...(cspNonce !== undefined && {
        cspNonce: true,
        cspNonceMode: cspNonce.mode,
        cspStrictDynamic: cspNonce.strictDynamic,
      }),
      now: () => Date.now(),
    });
    // eslint-disable-next-line security/detect-possible-timing-attacks -- both are the stack's own, compared once as it starts.
    if (staged.token !== token) {
      throw new Error(
        `the cache signed ${deploymentId}'s token otherwise than its Functions were given it`,
      );
    }
    await target.edgeState.put(POINTER_KEY, JSON.stringify(pointer));
    const served = await running.url(WORKERS.edge);
    const { app } = functions;
    return {
      url: siteUrlOf(served),
      siteOrigins: names.origins.split(','),
      functions: [PRIMARY_FUNCTION, ...Object.keys(app.functions ?? {})],
      backstage: await running.url(WORKERS.edge, BACKSTAGE_ENTRYPOINT),
      bundleDir,
      deploymentId,
      bundle,
      manifest: staged.manifest,
      app,
      policy,
      cspNonce,
      dispose: () => running.dispose(),
    };
  } catch (error) {
    await running.dispose();
    throw error;
  }
}
