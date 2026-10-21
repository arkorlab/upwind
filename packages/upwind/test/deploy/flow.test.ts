import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDeploy } from '../../src/deploy/command.ts';
import { functionScriptName, projectNames } from '../../src/deploy/names.ts';
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

    await expect(deploy(account(), dir)).rejects.toThrow(
      /changed while this run checked its version/u,
    );
    expect(scriptOn(account(), NAMES.edge).deployments[0]?.id).toBe('somebody-else');
  });
});

describe('`upwind deploy` stopped part way, and run again', () => {
  const { account, setUp, tearDown } = liveSuite();

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
