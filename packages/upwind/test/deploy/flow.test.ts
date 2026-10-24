import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentTakesKey } from '../../src/deploy/agent-client.ts';
import { type AgentInput, openAgent } from '../../src/deploy/agent-session.ts';
import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import { runDeploy } from '../../src/deploy/command.ts';
import type { DeploySettings } from '../../src/deploy/config.ts';
import { deployToAccount } from '../../src/deploy/deploy-run.ts';
import { functionScriptName, projectNames } from '../../src/deploy/names.ts';
import { preflight } from '../../src/deploy/preflight.ts';
import { shippedWorkers } from '../../src/deploy/shipped.ts';
import { READINESS_PATH } from '../../src/deploy/workers/protocol.ts';
import { bundleOf, deployableFunction, projectDir, writeBundle } from './bundle.ts';
import { fakeCloudflare } from './fake-cloudflare.ts';
import {
  buildIn,
  deployableProject,
  deployOptions,
  type LiveAccount,
  liveAccount,
  ownerMarkOf,
  scriptOn,
  servedBy,
  sorted,
} from './live-account.ts';

/**
 * `upwind deploy` from end to end: a build made live on an account that answers as Cloudflare's
 * does, with the agent and the cache authority running as uploaded (`live-account.ts`).
 */

// Bundled once for the file: every run would bundle the five Workers again otherwise.
vi.mock(import('../../src/deploy/shipped.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  const held: { workers?: ReturnType<typeof actual.shippedWorkers> } = {};
  return {
    ...actual,
    shippedWorkers: () => {
      held.workers ??= actual.shippedWorkers();
      return held.workers;
    },
  };
});

const PROJECT = 'shop';
const NAMES = projectNames(PROJECT);
const OWN_WORKERS = [NAMES.agent, NAMES.cache, NAMES.cacheRead, NAMES.edge, NAMES.prefetch];

/** An account a test deploys to, and what the run said went wrong; set up by each test's hooks. */
interface Suite {
  readonly account: () => LiveAccount;
  readonly errors: () => string[];
  readonly setUp: () => Promise<void>;
  readonly tearDown: () => Promise<void>;
}

function liveSuite(): Suite {
  const held: { account?: LiveAccount; errors: string[] } = { errors: [] };
  return {
    account: () => {
      if (held.account === undefined) {
        throw new Error('no account yet');
      }
      return held.account;
    },
    errors: () => held.errors,
    setUp: async () => {
      held.account = await liveAccount(PROJECT);
      held.errors = [];
      vi.spyOn(console, 'log').mockImplementation(() => {
        // A run says what it does; the tests read the account instead.
      });
      vi.spyOn(console, 'error').mockImplementation((text: string) => {
        held.errors.push(text);
      });
    },
    tearDown: async () => {
      vi.restoreAllMocks();
      await held.account?.dispose();
    },
  };
}

function deploy(account: LiveAccount, dir: string): Promise<number> {
  return runDeploy(deployOptions(dir), account.credentials, account.io);
}

/** The version the edge gives all of its traffic to. */
function liveVersion(account: LiveAccount): string | undefined {
  return scriptOn(account, NAMES.edge).deployments[0]?.versions[0]?.version_id;
}

describe('`upwind deploy` to an account', () => {
  const { account, errors, setUp, tearDown } = liveSuite();

  beforeEach(setUp, 60_000);

  afterEach(tearDown);

  it('makes the stores and the Workers, and puts a first deployment live', async () => {
    const dir = await deployableProject(PROJECT);
    const { deploymentId } = buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);
    expect(errors()).toStrictEqual([]);

    const { fake } = account();
    const mark = await ownerMarkOf(account());

    expect({
      scripts: sorted(fake.scripts.keys()),
      namespaces: sorted([...fake.kv.values()].map((namespace) => namespace.title)),
      marked: sorted(Object.keys(mark?.made ?? {})),
      pending: mark?.pending,
      served: servedBy(account(), NAMES.edge),
    }).toStrictEqual({
      scripts: sorted([...OWN_WORKERS, functionScriptName(PROJECT, deploymentId, 'app')]),
      namespaces: sorted([NAMES.cacheStateTitle, NAMES.edgeStateTitle]),
      marked: sorted([NAMES.cacheStateTitle, NAMES.edgeStateTitle]),
      pending: [],
      served: deploymentId,
    });
  });

  it('reaches the edge and the agent on workers.dev, and nothing else anywhere', async () => {
    const dir = await deployableProject(PROJECT);
    const { deploymentId } = buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);

    const reach = (name: string): unknown => scriptOn(account(), name).subdomain;
    const unreached = { enabled: false, previews_enabled: false };

    expect({
      edge: reach(NAMES.edge),
      agent: reach(NAMES.agent),
      cache: reach(NAMES.cache),
      cacheRead: reach(NAMES.cacheRead),
      prefetch: reach(NAMES.prefetch),
      app: reach(functionScriptName(PROJECT, deploymentId, 'app')),
    }).toStrictEqual({
      edge: { enabled: true, previews_enabled: false },
      agent: { enabled: true, previews_enabled: false },
      cache: unreached,
      cacheRead: unreached,
      prefetch: unreached,
      app: unreached,
    });
  });

  it('gives the agent a key nobody holds once the run is over', async () => {
    const dir = await deployableProject(PROJECT);
    buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);

    const held = scriptOn(account(), NAMES.agent).secrets.get('AGENT_KEY') ?? '';
    const [used = ''] = account().keys;

    expect(account().keys.size).toBe(1);
    expect(held).not.toBe('');
    expect(held).not.toBe(used);

    const asked = await account().fake.fetch(
      `https://${NAMES.agent}.example.workers.dev/v1/health`,
      { headers: { authorization: `Bearer ${used}` } },
    );

    expect(asked.status).toBe(401);
  });

  it('keeps the deployment live where the agent cannot be given another key', async () => {
    const dir = await deployableProject(PROJECT);
    const { deploymentId } = buildIn(dir);
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((text: string) => {
      warnings.push(text);
    });
    account().fake.fail({ method: 'PUT', path: `/workers/scripts/${NAMES.agent}/secrets` }, 400);

    await expect(deploy(account(), dir)).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(deploymentId);
    expect(warnings).toContainEqual(
      expect.stringContaining(
        `${NAMES.agent} may still take this run's key, until the next deploy or rollback replaces it`,
      ),
    );
  });

  it('checks the next deployment through its version before switching to it', async () => {
    const dir = await deployableProject(PROJECT);
    buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);

    const before = liveVersion(account());
    const { deploymentId } = buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);

    const [live, checking] = scriptOn(account(), NAMES.edge).deployments;
    const after = liveVersion(account());

    expect(servedBy(account(), NAMES.edge)).toBe(deploymentId);
    expect(live?.versions).toStrictEqual([{ version_id: after, percentage: 100 }]);
    expect(checking?.versions).toStrictEqual([
      { version_id: before, percentage: 100 },
      { version_id: after, percentage: 0 },
    ]);
    // Asked for by name while it held no traffic, and without a name once it held all of it.
    expect(account().overrides).toContain(`/__upwind/deployment ${NAMES.edge}="${String(after)}"`);
    expect(account().overrides).toContain(`/ ${NAMES.edge}="${String(after)}"`);
    expect(account().overrides.at(-1)).toBe('/__upwind/deployment -');
  });

  it('keeps the live version where the next one fails its checks', async () => {
    const dir = await deployableProject(PROJECT);
    const first = buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);

    const before = liveVersion(account());
    account().site = (_, version) =>
      version.id === before ? undefined : new Response('broken', { status: 500 });
    buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(1);
    expect(servedBy(account(), NAMES.edge)).toBe(first.deploymentId);
    expect(scriptOn(account(), NAMES.edge).deployments[0]?.versions).toStrictEqual([
      { version_id: before, percentage: 100 },
    ]);
    expect(errors().join('\n')).toMatch(/failed its checks, and nothing was switched/u);
    expect(errors().join('\n')).toMatch(/\/ was answered with 500/u);
  });

  it('switches nothing where the edge changed while its version was checked', async () => {
    const dir = await deployableProject(PROJECT);
    buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);

    const before = liveVersion(account()) ?? '';
    account().site = (request) => {
      // Somebody else gives the live version all of the traffic again, while the check runs.
      if (request.headers.has('cloudflare-workers-version-overrides')) {
        scriptOn(account(), NAMES.edge).deployments.unshift({
          id: 'somebody-else',
          versions: [{ version_id: before, percentage: 100 }],
        });
      }
    };
    buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(1);
    expect(scriptOn(account(), NAMES.edge).deployments[0]?.id).toBe('somebody-else');
    expect(errors().join('\n')).toMatch(/changed while this run checked/u);
  });

  it('puts nothing back where the edge changed while failing checks ran', async () => {
    const dir = await deployableProject(PROJECT);
    buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);

    const before = liveVersion(account()) ?? '';
    account().site = (request, version) => {
      if (version.id === before) {
        return;
      }
      // A rollback somebody makes while the new version fails its checks.
      scriptOn(account(), NAMES.edge).deployments.unshift({
        id: 'rolled-back',
        versions: [{ version_id: before, percentage: 100 }],
      });
      return new Response('broken', { status: request.url.endsWith('/') ? 500 : 200 });
    };
    buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(1);
    expect(scriptOn(account(), NAMES.edge).deployments[0]?.id).toBe('rolled-back');
    expect(errors().join('\n')).toMatch(/put nothing back/u);
  });
});

/** The site's own name, routed to the edge as a custom domain attached to it would be. */
const HOSTNAME = 'shop.example.com';

function throughHostname(live: LiveAccount): LiveAccount['io'] {
  return {
    ...live.io,
    fetch: (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname !== HOSTNAME) {
        return live.io.fetch(request);
      }
      url.hostname = `${NAMES.edge}.example.workers.dev`;
      return live.io.fetch(new Request(url, request));
    },
  };
}

describe("the edge's reach, as the settings change it", () => {
  const { account, setUp, tearDown } = liveSuite();

  beforeEach(setUp, 60_000);

  afterEach(tearDown);

  /**
   * Deploy one on workers.dev, then the next with `workersDev` off, reached on a hostname — from a
   * checkout of the project of its own, whose settings say so: a process reads a project's once.
   */
  async function offWorkersDev(broken: boolean): Promise<{ code: number; during: boolean[] }> {
    const first = await deployableProject(PROJECT);
    buildIn(first);

    await expect(deploy(account(), first)).resolves.toBe(0);

    const before = liveVersion(account());
    const during: boolean[] = [];
    account().site = (_, version) => {
      during.push(scriptOn(account(), NAMES.edge).subdomain.enabled);
      return broken && version.id !== before ? new Response('broken', { status: 500 }) : undefined;
    };
    const dir = await deployableProject(PROJECT, { workersDev: false, hostnames: [HOSTNAME] });
    buildIn(dir);
    const code = await runDeploy(
      deployOptions(dir),
      account().credentials,
      throughHostname(account()),
    );
    return { code, during };
  }

  it('is narrowed only once the new version has the traffic', async () => {
    const { code, during } = await offWorkersDev(false);

    expect(code).toBe(0);
    // On workers.dev while the version was checked, as the live one was reached there.
    expect(during.length).toBeGreaterThan(0);
    expect(during.every(Boolean)).toBe(true);
    expect(scriptOn(account(), NAMES.edge).subdomain.enabled).toBe(false);
  });

  it('is left as it was where the new version fails its checks', async () => {
    const { code } = await offWorkersDev(true);

    expect(code).toBe(1);
    expect(scriptOn(account(), NAMES.edge).subdomain.enabled).toBe(true);
  });

  it('is narrowed by a run of the live deployment where the run that made it live could not', async () => {
    const first = await deployableProject(PROJECT);
    buildIn(first);

    await expect(deploy(account(), first)).resolves.toBe(0);

    const dir = await deployableProject(PROJECT, { workersDev: false, hostnames: [HOSTNAME] });
    buildIn(dir);
    const again = (): Promise<number> =>
      runDeploy(deployOptions(dir), account().credentials, throughHostname(account()));
    // Refused once, and not asked again: the run warns and ends live, still on workers.dev.
    account().fake.fail({ method: 'POST', path: `/workers/scripts/${NAMES.edge}/subdomain` }, 400);

    await expect(again()).resolves.toBe(0);
    expect(scriptOn(account(), NAMES.edge).subdomain.enabled).toBe(true);

    // The same deployment again: nothing staged or switched, and the narrowing done.
    await expect(again()).resolves.toBe(0);
    expect(scriptOn(account(), NAMES.edge).subdomain.enabled).toBe(false);
  });
});

describe("the edge's Cron Triggers, as the deployments' cron jobs say", () => {
  const { account, errors, setUp, tearDown } = liveSuite();

  beforeEach(setUp, 60_000);

  afterEach(tearDown);

  const JOBS = [
    { path: '/api/tick', schedule: '0 * * * *' },
    { path: '/api/weekly', schedule: '0 9 * * 1' },
    { path: '/api/also-hourly', schedule: '0 */1 * * *' },
  ];

  function triggers(): readonly string[] | undefined {
    return scriptOn(account(), NAMES.edge).schedules;
  }

  it("are set to a deployment's jobs once it is live, Monday written as Cloudflare numbers it", async () => {
    const dir = await deployableProject(PROJECT);
    buildIn(dir, { crons: JOBS });

    await expect(deploy(account(), dir)).resolves.toBe(0);
    expect(errors()).toStrictEqual([]);
    // Two schedules that select the same minutes share one trigger.
    expect(triggers()).toStrictEqual(['0 * * * *', '0 9 * * 2']);
  });

  it('are taken away by a deployment with no jobs', async () => {
    const first = await deployableProject(PROJECT);
    buildIn(first, { crons: JOBS });

    await expect(deploy(account(), first)).resolves.toBe(0);

    const dir = await deployableProject(PROJECT);
    buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);
    expect(triggers()).toStrictEqual([]);
  });

  it('are left as they were where the new version fails its checks', async () => {
    const first = await deployableProject(PROJECT);
    buildIn(first, { crons: JOBS });

    await expect(deploy(account(), first)).resolves.toBe(0);

    const before = liveVersion(account());
    account().site = (_, version) =>
      version.id === before ? undefined : new Response('broken', { status: 500 });
    const dir = await deployableProject(PROJECT);
    buildIn(dir, { crons: [{ path: '/api/daily', schedule: '0 0 * * *' }] });

    await expect(deploy(account(), dir)).resolves.toBe(1);
    expect(triggers()).toStrictEqual(['0 * * * *', '0 9 * * 2']);
  });

  it('are set by a run of the live deployment where the run that made it live could not', async () => {
    const dir = await deployableProject(PROJECT);
    const { deploymentId } = buildIn(dir, { crons: JOBS });
    account().fake.fail({ method: 'PUT', path: `/workers/scripts/${NAMES.edge}/schedules` }, 400);

    // Live, and said to have no triggers: the run ends in failure for it.
    await expect(deploy(account(), dir)).resolves.toBe(1);
    expect(servedBy(account(), NAMES.edge)).toBe(deploymentId);
    expect(triggers()).toBeUndefined();
    expect(errors()).toContainEqual(expect.stringMatching(/Cron Triggers were not set/u));

    await expect(deploy(account(), dir)).resolves.toBe(0);
    expect(triggers()).toStrictEqual(['0 * * * *', '0 9 * * 2']);
  });
});

describe("a run's key to the agent", () => {
  const { account, setUp, tearDown } = liveSuite();

  beforeEach(setUp, 60_000);

  afterEach(tearDown);

  it('is taken away at its end only while it is still the one the agent takes', async () => {
    const live = account();
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((text: string) => {
      warnings.push(text);
    });
    const scope = {
      client: createCloudflareClient({
        apiToken: 'token',
        fetch: live.io.fetch,
        sleep: live.io.sleep,
      }),
      accountId: 'account-1',
    };
    const input: AgentInput = {
      scope,
      names: NAMES,
      stores: { bucket: NAMES.artifactsBucket, edgeState: undefined },
      script: (await shippedWorkers()).agent,
      subdomain: 'example',
      mode: 'deploy',
      existing: new Set(),
      withCache: false,
      ...live.io,
    };
    const older = await openAgent(input);
    // A newer run sets a key of its own while the older one is still going.
    const newer = await openAgent({ ...input, existing: new Set([NAMES.agent]) });

    await older.close();

    await expect(agentTakesKey(newer.client)).resolves.toBe(true);
    expect(warnings.join('\n')).toMatch(/does not take this run's key/u);

    await newer.close();

    await expect(agentTakesKey(newer.client)).resolves.toBe(false);
  });
});

describe('`upwind deploy` stopped part way, and run again', () => {
  const { account, errors, setUp, tearDown } = liveSuite();

  beforeEach(setUp, 60_000);

  afterEach(tearDown);

  it.each([
    ['a Function', (deploymentId: string) => functionScriptName(PROJECT, deploymentId, 'app')],
    ['the edge', () => NAMES.edge],
    ['the cache', () => NAMES.cache],
  ])('ends where an uninterrupted run would when stopped at %s', async (_, scriptOf) => {
    const dir = await deployableProject(PROJECT);
    const { deploymentId } = buildIn(dir);
    account().fake.fail({ method: 'PUT', path: `/workers/scripts/${scriptOf(deploymentId)}` }, 400);

    await expect(deploy(account(), dir)).rejects.toThrow(/injected/u);
    await expect(deploy(account(), dir)).resolves.toBe(0);

    const { fake } = account();

    expect({
      scripts: sorted(fake.scripts.keys()),
      namespaces: sorted([...fake.kv.values()].map((namespace) => namespace.title)),
      served: servedBy(account(), NAMES.edge),
      live: scriptOn(account(), NAMES.edge).deployments[0]?.versions.length,
      pending: (await ownerMarkOf(account()))?.pending,
    }).toStrictEqual({
      scripts: sorted([...OWN_WORKERS, functionScriptName(PROJECT, deploymentId, 'app')]),
      namespaces: sorted([NAMES.cacheStateTitle, NAMES.edgeStateTitle]),
      served: deploymentId,
      live: 1,
      pending: [],
    });
  });

  it('switches on a second run that stopped before its switch', async () => {
    const dir = await deployableProject(PROJECT);
    buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);

    const { deploymentId } = buildIn(dir);
    account().fake.fail(
      { method: 'POST', path: `/workers/scripts/${NAMES.edge}/deployments` },
      400,
    );

    await expect(deploy(account(), dir)).rejects.toThrow(/injected/u);
    expect(servedBy(account(), NAMES.edge)).not.toBe(deploymentId);
    await expect(deploy(account(), dir)).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(deploymentId);
  });

  it('cleans up, run again for the live deployment, where the run that made it live could not', async () => {
    const first = await deployableProject(PROJECT);
    const older = buildIn(first).deploymentId;

    await expect(deploy(account(), first)).resolves.toBe(0);

    const dir = await deployableProject(PROJECT);
    buildIn(dir);
    const keepNone = (): Promise<number> =>
      runDeploy(deployOptions(dir, { keep: 0 }), account().credentials, account().io);
    const olderApp = functionScriptName(PROJECT, older, 'app');
    // Refused once, and not asked again: the run warns and ends live, the older one still there.
    account().fake.fail({ method: 'DELETE', path: `/workers/scripts/${olderApp}` }, 400);

    await expect(keepNone()).resolves.toBe(0);
    expect(account().fake.scripts.has(olderApp)).toBe(true);

    // The same deployment again: nothing staged or switched, and the cleanup done.
    await expect(keepNone()).resolves.toBe(0);
    expect(account().fake.scripts.has(olderApp)).toBe(false);
  });

  /**
   * Two deployments made live in turn, the first kept; then the second run again, keeping none, as
   * a run of the live deployment that has to confirm it first.
   */
  async function rerunKeepingNone(): Promise<{
    readonly olderApp: string;
    rerun: () => Promise<number>;
  }> {
    const first = await deployableProject(PROJECT);
    const older = buildIn(first).deploymentId;

    await expect(deploy(account(), first)).resolves.toBe(0);

    const dir = await deployableProject(PROJECT);
    buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);

    return {
      olderApp: functionScriptName(PROJECT, older, 'app'),
      rerun: () => runDeploy(deployOptions(dir, { keep: 0 }), account().credentials, account().io),
    };
  }

  it('deletes nothing, run again for a live deployment that fails its checks', async () => {
    const { olderApp, rerun } = await rerunKeepingNone();
    const edge = scriptOn(account(), NAMES.edge);
    const before = { versions: edge.versions.length, deployments: edge.deployments.length };
    // The live deployment's pages fail now, as one a run left failing its checks would.
    account().site = () => new Response('broken', { status: 500 });

    await expect(rerun()).resolves.toBe(1);
    expect(errors().some((line) => line.includes('failed its checks'))).toBe(true);
    // The deployment before it is still there to be rolled back to, and the edge as it was.
    expect(account().fake.scripts.has(olderApp)).toBe(true);
    expect({ versions: edge.versions.length, deployments: edge.deployments.length }).toStrictEqual(
      before,
    );
  });

  it('deletes nothing, run again for a live deployment that never answers as itself', async () => {
    const { olderApp, rerun } = await rerunKeepingNone();
    const answer = account().fake.workersDev.get(NAMES.edge);
    // The live version no longer says which deployment it serves.
    account().fake.workersDev.set(NAMES.edge, (request, version, script) => {
      return answer === undefined || new URL(request.url).pathname === READINESS_PATH
        ? new Response(null, { status: 503 })
        : answer(request, version, script);
    });

    await expect(rerun()).resolves.toBe(3);
    expect(account().fake.scripts.has(olderApp)).toBe(true);
  });

  it('does nothing for the deployment that is live already', async () => {
    const dir = await deployableProject(PROJECT);
    const { deploymentId } = buildIn(dir);

    await expect(deploy(account(), dir)).resolves.toBe(0);

    const edge = scriptOn(account(), NAMES.edge);
    const before = { versions: edge.versions.length, deployments: edge.deployments.length };

    await expect(deploy(account(), dir)).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(deploymentId);
    expect({ versions: edge.versions.length, deployments: edge.deployments.length }).toStrictEqual(
      before,
    );
  });
});

describe('a route gate the command cannot bind', () => {
  it.each(['/', '/robots.txt'])(
    'refuses before reaching an account when checks name %s',
    async (check) => {
      const dir = projectDir();
      writeBundle(dir, bundleOf(deployableFunction(dir), { gates: { '/': 'members' } }));
      const settings: DeploySettings = {
        file: undefined,
        project: PROJECT,
        workersDev: true,
        hostnames: [],
        keep: 5,
        storage: [],
        secrets: [],
        images: false,
        checks: [check],
        cspNonce: undefined,
        logs: false,
      };
      const secrets: ReadonlyMap<string, string> = new Map();
      const plan = await preflight({ projectDir: dir, settings, secrets });
      const remote = fakeCloudflare();
      // A missing refusal stops at the first lock request rather than uploading any Worker.
      remote.fail({ method: 'POST', path: '/r2/buckets' }, 400);

      await expect(
        deployToAccount({
          scope: {
            client: createCloudflareClient({ apiToken: 'token', fetch: remote.fetch }),
            accountId: 'account-1',
          },
          settings,
          plan,
          secrets,
          message: undefined,
          resetCacheKey: false,
          fetch: remote.fetch,
        }),
      ).rejects.toThrow(/route gates.*`upwind deploy` does not bind yet/u);

      expect({
        remoteCalls: remote.requests.length + remote.workersDevRequests.length,
        workers: remote.scripts.size,
        buckets: remote.buckets.size,
      }).toStrictEqual({ remoteCalls: 0, workers: 0, buckets: 0 });
    },
  );
});
