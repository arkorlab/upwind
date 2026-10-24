import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import { compareCodeUnits } from '@stayingupwind/core/util';

import type { DeployOptions } from '../../src/deploy/args.ts';
import type { CloudflareCredentials } from '../../src/deploy/credentials.ts';
import {
  AGENT_KEY_MIN_LENGTH,
  OWNER_KEY,
  READINESS_PATH,
} from '../../src/deploy/workers/protocol.ts';
import { ownVersion } from '../../src/manifest.ts';
import { bundleOf, deployableFunction, moduleOf, projectDir, writeBundle } from './bundle.ts';
import {
  bindingText,
  type FakeCloudflare,
  fakeCloudflare,
  type FakeScript,
  type FakeVersion,
  selectedVersion,
} from './fake-cloudflare.ts';
import { projectWith } from './project.ts';
import { AGENT_KEY, type RunningStack, runStack } from './workers/stack.ts';

/**
 * An account a deploy runs against from end to end: Cloudflare's API in memory (`fakeCloudflare`),
 * and behind the `workers.dev` names it routes, the Workers a deploy uploads as they run.
 *
 * The agent is the bundled agent under Miniflare, over the stores and the cache authority of a
 * running stack (`runStack`), reached only with the key the account last gave it — the one an
 * upload carried, or one set alone — as Cloudflare's own copy of the agent would be. The edge is
 * answered here, from the version Cloudflare would route a request to: its readiness from the
 * pointer that version was uploaded with, and whether the manifest that pointer names is in the
 * stack's stores; the site's pages as the test says (`site`), a 200 where it says nothing. The
 * project's bucket keeps its objects in the stack's, so the API and the agent see the same ones.
 */

const BEARER = 'Bearer ';
const OVERRIDE_HEADER = 'cloudflare-workers-version-overrides';
/** Headers the forwarded request sets itself, or carries a key it must not. */
const NOT_FORWARDED = new Set(['authorization', 'content-length', 'host']);

export interface LiveAccount {
  readonly fake: FakeCloudflare;
  readonly stack: RunningStack;
  readonly credentials: CloudflareCredentials;
  /** Every key the agent was asked with and took. */
  readonly keys: Set<string>;
  /** The version override each request to the edge named, by its path; `-` for none. */
  readonly overrides: string[];
  /** What the site answers besides the edge's readiness; a 200 wherever it answers nothing. */
  site?: ((request: Request, version: FakeVersion) => Response | undefined) | undefined;
  /** What a run reaches the account with, and a clock that moves only as the run waits. */
  readonly io: {
    readonly fetch: typeof fetch;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
  };
  dispose(): Promise<void>;
}

/** The agent: the stack's, asked with the stack's own key once the account's has been checked. */
async function forwardToAgent(
  account: LiveAccount,
  request: Request,
  version: FakeVersion,
  held: string | undefined,
): Promise<Response> {
  if (held === undefined || held.length < AGENT_KEY_MIN_LENGTH) {
    return new Response('the agent holds no key', { status: 503 });
  }
  const header = request.headers.get('authorization') ?? '';
  const given = header.startsWith(BEARER) ? header.slice(BEARER.length) : '';
  if (given !== held) {
    return new Response(null, { status: 401 });
  }
  account.keys.add(given);
  const destroying = bindingText(version, 'AGENT_MODE') === 'destroy';
  const target = await account.stack.url(destroying ? 'agent-destroying' : 'agent');
  const url = new URL(request.url);
  const headers = new Headers({ authorization: `${BEARER}${AGENT_KEY}` });
  for (const [name, value] of request.headers) {
    if (!NOT_FORWARDED.has(name)) {
      headers.set(name, value);
    }
  }
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  return fetch(new URL(`${url.pathname}${url.search}`, target), {
    method: request.method,
    headers,
    ...(body !== undefined && { body }),
  });
}

/** The pointer a version of the edge was uploaded with, read loosely. */
function pointerOf(version: FakeVersion): { manifestId?: string; deploymentId?: string } {
  const text = bindingText(version, 'POINTER');
  const pointer: unknown = text === undefined ? undefined : JSON.parse(text);
  if (typeof pointer !== 'object' || pointer === null) {
    return {};
  }
  const manifestId: unknown = Reflect.get(pointer, 'manifestId');
  const app: unknown = Reflect.get(pointer, 'app');
  const deploymentId: unknown =
    typeof app === 'object' && app !== null ? Reflect.get(app, 'deploymentId') : undefined;
  return {
    ...(typeof manifestId === 'string' && { manifestId }),
    ...(typeof deploymentId === 'string' && { deploymentId }),
  };
}

/** An account, empty, and the stack behind it; one per test, since a bucket has one owner mark. */
export async function liveAccount(project: string): Promise<LiveAccount> {
  const fake = fakeCloudflare();
  const stack = await runStack();
  const edgeState = await stack.mf.getKVNamespace('EDGE_STATE', 'agent');
  const artifacts = await stack.mf.getR2Bucket('ARTIFACTS', 'agent');
  const clock = { now: 0 };
  const account: LiveAccount = {
    fake,
    stack,
    credentials: { apiToken: 'token', accountId: undefined },
    keys: new Set(),
    overrides: [],
    io: {
      fetch: fake.fetch,
      sleep: (ms) => {
        clock.now += ms;
        return Promise.resolve();
      },
      now: () => clock.now,
    },
    dispose: () => stack.dispose(),
  };
  fake.linkBucket(`${project}-artifacts`, {
    get: async (key) => {
      const object = await artifacts.get(key);
      if (object === null) {
        return;
      }
      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      };
    },
    put: async (key, bytes, contentType) => {
      await artifacts.put(key, bytes, { httpMetadata: { contentType } });
    },
    delete: async (key) => {
      await artifacts.delete(key);
    },
    isEmpty: async () => (await artifacts.list({ limit: 1 })).objects.length === 0,
  });
  fake.workersDev.set(`${project}-agent`, (request, version, script) =>
    forwardToAgent(account, request, version, script.secrets.get('AGENT_KEY')),
  );
  fake.workersDev.set(`${project}-edge`, async (request, version) => {
    const url = new URL(request.url);
    account.overrides.push(`${url.pathname} ${request.headers.get(OVERRIDE_HEADER) ?? '-'}`);
    if (url.pathname !== READINESS_PATH) {
      return account.site?.(request, version) ?? new Response('a page');
    }
    const { manifestId, deploymentId } = pointerOf(version);
    const kv = manifestId !== undefined && (await edgeState.get(`manifest:${manifestId}`)) !== null;
    const r2 =
      manifestId !== undefined && (await artifacts.head(`manifests/${manifestId}.json`)) !== null;
    return Response.json({ deploymentId, manifestId, versionId: version.id, manifest: { kv, r2 } });
  });
  return account;
}

/** A project with the adapter a deploy reads its settings with. */
export async function deployableProject(project: string, deploy?: unknown): Promise<string> {
  const dir = projectDir();
  projectWith({
    dir,
    adapterVersion: await ownVersion(),
    packageName: project,
    config: { file: undefined, crons: [], ...(deploy !== undefined && { deploy }) },
  });
  return dir;
}

/** A build of a new deployment in the project, as `upwind deploy --build-only` leaves one. */
export function buildIn(
  dir: string,
  extra: Pick<Partial<DeploymentBundle>, 'crons'> = {},
): DeploymentBundle {
  const bundle = bundleOf(deployableFunction(dir), extra);
  const robots = moduleOf(dir, 'robots.txt', 'text', `User-agent: *\n# ${bundle.deploymentId}\n`);
  const built = {
    ...bundle,
    staticFiles: [
      {
        pathname: '/robots.txt',
        blob: { ...robots.blob, contentType: 'text/plain; charset=utf-8' },
        immutable: false,
      },
    ],
  };
  writeBundle(dir, built);
  const note = { v: 1, deploymentId: built.deploymentId, upwind: '0.4.0', builtAt: 'now' };
  writeFileSync(path.join(dir, '.arkor/upwind-deploy.json'), JSON.stringify(note));
  return built;
}

/** A deploy of what the project's build left, all the way to the account. */
export function deployOptions(dir: string, overrides: Partial<DeployOptions> = {}): DeployOptions {
  return {
    projectDir: dir,
    prebuilt: true,
    buildOnly: false,
    envFiles: [],
    keep: undefined,
    message: undefined,
    dryRun: false,
    resetCacheKey: false,
    ...overrides,
  };
}

export function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted(compareCodeUnits);
}

/** The Worker of that name on the account; a failure where there is none. */
export function scriptOn(account: LiveAccount, name: string): FakeScript {
  const script = account.fake.scripts.get(name);
  if (script === undefined) {
    throw new Error(`the account has no ${name}`);
  }
  return script;
}

/** The deployment an edge serves now, as the version its traffic goes to names it. */
export function servedBy(account: LiveAccount, edge: string): string | undefined {
  const script = account.fake.scripts.get(edge);
  const version =
    script === undefined ? undefined : selectedVersion(script, new Request('https://example.com/'));
  return version === undefined ? undefined : pointerOf(version).deploymentId;
}

/** The keys the project's bucket holds, as the agent and the API see them. */
export async function bucketKeys(account: LiveAccount): Promise<string[]> {
  const bucket = await account.stack.mf.getR2Bucket('ARTIFACTS', 'agent');
  return (await bucket.list()).objects.map((object) => object.key);
}

/** What the owner mark in the project's bucket says; nothing where there is none. */
export async function ownerMarkOf(
  account: LiveAccount,
): Promise<
  | { readonly project: string; readonly made: Record<string, string>; readonly pending: string[] }
  | undefined
> {
  const bucket = await account.stack.mf.getR2Bucket('ARTIFACTS', 'agent');
  const object = await bucket.get(OWNER_KEY);
  return object === null
    ? undefined
    : ((await object.json()) as {
        readonly project: string;
        readonly made: Record<string, string>;
        readonly pending: string[];
      });
}
