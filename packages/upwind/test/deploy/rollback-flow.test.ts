import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import { compareCodeUnits } from '@stayingupwind/core/util';
import { blobObjectKey, bundleObjectKey } from '@stayingupwind/host/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentClient } from '../../src/deploy/agent-client.ts';
import { runDeploy } from '../../src/deploy/command.ts';
import { projectNames } from '../../src/deploy/names.ts';
import { runRollback } from '../../src/deploy/rollback.ts';
import { remoteTarget } from '../../src/deploy/target.ts';
import { AGENT_PATHS } from '../../src/deploy/workers/protocol.ts';
import { bundleOf, deployableFunction, moduleOf, writeBundle } from './bundle.ts';
import { bindingText } from './fake-cloudflare.ts';
import {
  deployableProject,
  deployOptions,
  type LiveAccount,
  liveAccount,
  scriptOn,
  servedBy,
} from './live-account.ts';
import { AGENT_KEY } from './workers/stack.ts';

/**
 * `upwind rollback` from end to end, on an account that answers as Cloudflare's does, with the
 * agent and the cache authority running as uploaded (`live-account.ts`): the deployment gone back
 * to is published again against the one that was live, so that deployment's files stay served.
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

/**
 * A build whose page loads a script of its own name, as each build's chunks are its own; and, where
 * asked, a file of its `public/` beside it.
 */
function buildWith(dir: string, chunk: string, publicFile?: string): DeploymentBundle {
  const bundle = bundleOf(deployableFunction(dir));
  const script = moduleOf(dir, `${chunk}.js`, 'text', `console.log(${JSON.stringify(chunk)});\n`);
  const shipped = publicFile === undefined ? undefined : moduleOf(dir, publicFile, 'text', chunk);
  const built = {
    ...bundle,
    staticFiles: [
      {
        pathname: `/_next/static/chunks/${chunk}.js`,
        blob: { ...script.blob, contentType: 'text/javascript; charset=utf-8' },
        immutable: true,
      },
      ...(shipped === undefined
        ? []
        : [
            {
              pathname: `/${publicFile ?? ''}`,
              blob: { ...shipped.blob, contentType: 'text/plain; charset=utf-8' },
              immutable: false,
            },
          ]),
    ],
  };
  writeBundle(dir, built);
  const note = { v: 1, deploymentId: built.deploymentId, upwind: '0.4.0', builtAt: 'now' };
  writeFileSync(path.join(dir, '.arkor/upwind-deploy.json'), JSON.stringify(note));
  return built;
}

/** The version the edge gives all of its traffic to. */
function liveVersion(account: LiveAccount): string | undefined {
  return scriptOn(account, NAMES.edge).deployments[0]?.versions[0]?.version_id;
}

/** The manifest the edge's live version serves by, as the stores hold it. */
async function servedManifest(
  account: LiveAccount,
): Promise<{ readonly staticFiles?: Record<string, unknown> }> {
  const edge = scriptOn(account, NAMES.edge);
  const version = edge.versions.find((candidate) => candidate.id === liveVersion(account));
  const pointer = version === undefined ? undefined : bindingText(version, 'POINTER');
  const { manifestId } = JSON.parse(pointer ?? '{}') as { readonly manifestId?: string };
  const state = await account.stack.mf.getKVNamespace('EDGE_STATE', 'agent');
  const manifest = await state.get(`manifest:${String(manifestId)}`);
  return JSON.parse(manifest ?? '{}') as { readonly staticFiles?: Record<string, unknown> };
}

describe('`upwind rollback` on an account', () => {
  const held: { account?: LiveAccount; warnings: string[]; errors: string[] } = {
    warnings: [],
    errors: [],
  };
  const account = (): LiveAccount => {
    if (held.account === undefined) {
      throw new Error('no account yet');
    }
    return held.account;
  };

  beforeEach(async () => {
    held.account = await liveAccount(PROJECT);
    held.warnings = [];
    held.errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => {
      // A run says what it does; the tests read the account instead.
    });
    vi.spyOn(console, 'warn').mockImplementation((text: string) => {
      held.warnings.push(text);
    });
    vi.spyOn(console, 'error').mockImplementation((text: string) => {
      held.errors.push(text);
    });
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await held.account?.dispose();
  });

  /** Two deployments made, the second live; the first's own version of the edge. */
  async function twoDeployed(dir: string): Promise<{
    readonly first: DeploymentBundle;
    readonly second: DeploymentBundle;
    readonly firstVersion: string | undefined;
  }> {
    const first = buildWith(dir, 'one');

    await expect(runDeploy(deployOptions(dir), account().credentials, account().io)).resolves.toBe(
      0,
    );

    const firstVersion = liveVersion(account());
    const second = buildWith(dir, 'two');

    await expect(runDeploy(deployOptions(dir), account().credentials, account().io)).resolves.toBe(
      0,
    );
    expect(servedBy(account(), NAMES.edge)).toBe(second.deploymentId);

    return { first, second, firstVersion };
  }

  it("publishes the deployment again with the live one's files beside its own", async () => {
    const dir = await deployableProject(PROJECT);
    const { first, firstVersion } = await twoDeployed(dir);

    await expect(
      runRollback({ projectDir: dir, to: undefined }, account().credentials, account().io),
    ).resolves.toBe(0);
    expect(held.errors).toStrictEqual([]);
    expect(servedBy(account(), NAMES.edge)).toBe(first.deploymentId);
    // A version of its own, made now, whose pointer names a manifest staged against the second.
    expect(liveVersion(account())).not.toBe(firstVersion);

    const manifest = await servedManifest(account());

    expect(Object.keys(manifest.staticFiles ?? {}).toSorted(compareCodeUnits)).toStrictEqual([
      '/_next/static/chunks/one.js',
      '/_next/static/chunks/two.js',
    ]);
  });

  it('discards the key it took the agent with, as a deploy does', async () => {
    const dir = await deployableProject(PROJECT);
    await twoDeployed(dir);
    const before = new Set(account().keys);

    await expect(
      runRollback({ projectDir: dir, to: undefined }, account().credentials, account().io),
    ).resolves.toBe(0);

    // Every key the agent took after the two deploys: the rollback's own.
    const taken: string[] = [];
    for (const key of account().keys) {
      if (!before.has(key)) {
        taken.push(key);
      }
    }
    const agentKey = scriptOn(account(), NAMES.agent).secrets.get('AGENT_KEY');

    expect(taken).toHaveLength(1);
    expect(agentKey).not.toBe(taken[0]);
  });

  it('refuses a deployment named whose bundle is not kept, and switches nothing', async () => {
    const dir = await deployableProject(PROJECT);
    const { first, second } = await twoDeployed(dir);
    const live = liveVersion(account());
    const bucket = await account().stack.mf.getR2Bucket('ARTIFACTS', 'agent');
    await bucket.delete(bundleObjectKey(PROJECT, first.deploymentId));

    await expect(
      runRollback({ projectDir: dir, to: first.deploymentId }, account().credentials, account().io),
    ).resolves.toBe(1);
    // Its own version as it stands would serve none of the second's files, and nothing would have
    // asked whether its cache scope still answers.
    expect(liveVersion(account())).toBe(live);
    expect(servedBy(account(), NAMES.edge)).toBe(second.deploymentId);
    expect(held.errors).toStrictEqual([
      expect.stringContaining(
        `keeps no bundle of ${first.deploymentId}, so it cannot be published again`,
      ),
    ]);
  });

  it('keeps the live deployment where the one it goes back to fails its checks', async () => {
    const dir = await deployableProject(PROJECT);
    const { second } = await twoDeployed(dir);
    const live = liveVersion(account());
    account().site = (_, version) =>
      version.id === live ? undefined : new Response('broken', { status: 500 });

    await expect(
      runRollback({ projectDir: dir, to: undefined }, account().credentials, account().io),
    ).resolves.toBe(1);
    expect(liveVersion(account())).toBe(live);
    expect(servedBy(account(), NAMES.edge)).toBe(second.deploymentId);
    expect(held.errors).toContainEqual('  - / was answered with 500');
  });

  /** Three deployments made, one after another, the third live. */
  async function threeDeployed(dir: string): Promise<readonly DeploymentBundle[]> {
    const builds: DeploymentBundle[] = [];
    for (const chunk of ['one', 'two', 'three']) {
      builds.push(buildWith(dir, chunk));

      await expect(
        runDeploy(deployOptions(dir), account().credentials, account().io),
      ).resolves.toBe(0);
    }
    return builds;
  }

  /** A deployment's cache scope retired, as a cleanup that stopped before its Functions leaves it. */
  async function retire(deploymentId: string): Promise<void> {
    const agent = agentClient({ url: await account().stack.url('agent'), key: AGENT_KEY });
    await remoteTarget(agent, '/nowhere').cache.retireScope({
      scopeId: deploymentId,
      reason: 'a cleanup that stopped',
    });
  }

  it('goes further back with each rollback, publishing each again', async () => {
    const dir = await deployableProject(PROJECT);
    const [one, two] = await threeDeployed(dir);
    const rollBack = () =>
      runRollback({ projectDir: dir, to: undefined }, account().credentials, account().io);

    await expect(rollBack()).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(two?.deploymentId);

    // The second has the edge's newest version now; going back again goes to the first.
    await expect(rollBack()).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(one?.deploymentId);
    expect(held.errors).toStrictEqual([]);
  });

  it('passes over a deployment whose bundle is not kept, to the one before it', async () => {
    const dir = await deployableProject(PROJECT);
    const [one, two] = await threeDeployed(dir);
    const bucket = await account().stack.mf.getR2Bucket('ARTIFACTS', 'agent');
    await bucket.delete(bundleObjectKey(PROJECT, String(two?.deploymentId)));

    await expect(
      runRollback({ projectDir: dir, to: undefined }, account().credentials, account().io),
    ).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(one?.deploymentId);
    expect(held.warnings).toContainEqual(
      expect.stringContaining(`keeps no bundle of ${String(two?.deploymentId)}`),
    );
  });

  it('passes over a deployment whose cache scope a stopped cleanup retired', async () => {
    const dir = await deployableProject(PROJECT);
    const [one, two, three] = await threeDeployed(dir);
    await retire(String(two?.deploymentId));

    await expect(
      runRollback({ projectDir: dir, to: undefined }, account().credentials, account().io),
    ).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(one?.deploymentId);
    expect(held.warnings).toContainEqual(
      expect.stringContaining(`${String(two?.deploymentId)}'s cache scope refuses it`),
    );

    // Named, it is refused, and nothing is switched.
    await expect(
      runRollback({ projectDir: dir, to: two?.deploymentId }, account().credentials, account().io),
    ).resolves.toBe(1);
    expect(servedBy(account(), NAMES.edge)).toBe(one?.deploymentId);
    expect(held.errors).toContainEqual(expect.stringContaining('so it cannot be gone back to'));
    expect(three).toBeDefined();
  });

  /** The blob of a build's own script deleted from the bucket; its digest. */
  async function loseScript(build: DeploymentBundle | undefined): Promise<string> {
    const sha256 = String(build?.staticFiles[0]?.blob.sha256);
    const bucket = await account().stack.mf.getR2Bucket('ARTIFACTS', 'agent');
    await bucket.delete(blobObjectKey(sha256));
    return sha256;
  }

  /** The bundle the bucket keeps of a deployment, written over with other bytes. */
  async function spoilBundle(deploymentId: string | undefined, bytes: string): Promise<void> {
    const bucket = await account().stack.mf.getR2Bucket('ARTIFACTS', 'agent');
    await bucket.put(bundleObjectKey(PROJECT, String(deploymentId)), bytes);
  }

  const rollBack = (dir: string, to?: string) =>
    runRollback({ projectDir: dir, to }, account().credentials, account().io);

  it('passes over a deployment whose staging is refused, and refuses it named', async () => {
    const dir = await deployableProject(PROJECT);
    const [one, two] = await threeDeployed(dir);
    const lost = await loseScript(two);
    const refused = `publishing ${String(two?.deploymentId)} again is refused (blob ${lost} was not uploaded), so it cannot be gone back to`;

    await expect(
      runRollback({ projectDir: dir, to: undefined }, account().credentials, account().io),
    ).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(one?.deploymentId);
    expect(held.warnings).toContainEqual(expect.stringContaining(refused));

    // Named, it is refused, saying why, and nothing is switched.
    const live = liveVersion(account());

    await expect(
      runRollback({ projectDir: dir, to: two?.deploymentId }, account().credentials, account().io),
    ).resolves.toBe(1);
    expect(liveVersion(account())).toBe(live);
    expect(held.errors).toStrictEqual([`upwind: ${refused}`]);
  });

  it('refuses, saying why of each, where every deployment it tries is refused', async () => {
    const dir = await deployableProject(PROJECT);
    const [one, two] = await threeDeployed(dir);
    const live = liveVersion(account());
    const lost = [await loseScript(two), await loseScript(one)];

    await expect(rollBack(dir)).resolves.toBe(1);
    expect(liveVersion(account())).toBe(live);
    expect(held.errors).toStrictEqual([
      'upwind: no deployment before the live one can be rolled back to; each one tried was passed over:',
      ...[two, one].map(
        (build, index) =>
          `  - publishing ${String(build?.deploymentId)} again is refused (blob ${String(lost[index])} was not uploaded), so it cannot be gone back to`,
      ),
    ]);
  });

  it("goes back without a file of the live deployment's the bucket lost", async () => {
    const dir = await deployableProject(PROJECT);
    const [, two, three] = await threeDeployed(dir);
    // Each deployment gone back to would serve the live one's files beside its own.
    const lost = await loseScript(three);

    await expect(rollBack(dir)).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(two?.deploymentId);
    expect(held.warnings).toContainEqual(
      `upwind: warning: ${NAMES.artifactsBucket} no longer holds 1 of the files of ${String(three?.deploymentId)}, the live deployment (blob ${lost}): the rest are carried over, and its pages still open may lose those`,
    );
    expect(held.warnings).not.toContainEqual(expect.stringContaining('trying the deployment'));

    const manifest = await servedManifest(account());

    expect(Object.keys(manifest.staticFiles ?? {})).toStrictEqual(['/_next/static/chunks/two.js']);
  });

  it("carries over the live deployment's scripts where the bucket lost a file beside them", async () => {
    const dir = await deployableProject(PROJECT);
    const two = buildWith(dir, 'two');

    await expect(runDeploy(deployOptions(dir), account().credentials, account().io)).resolves.toBe(
      0,
    );

    const three = buildWith(dir, 'three', 'robots.txt');

    await expect(runDeploy(deployOptions(dir), account().credentials, account().io)).resolves.toBe(
      0,
    );

    // A file of its `public/`, which is not carried over, gone: its scripts still are.
    const bucket = await account().stack.mf.getR2Bucket('ARTIFACTS', 'agent');
    const robots = String(three.staticFiles[1]?.blob.sha256);
    await bucket.delete(blobObjectKey(robots));

    await expect(rollBack(dir)).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(two.deploymentId);
    expect(held.warnings).toContainEqual(expect.stringContaining(`(blob ${robots})`));

    const manifest = await servedManifest(account());

    expect(Object.keys(manifest.staticFiles ?? {}).toSorted(compareCodeUnits)).toStrictEqual([
      '/_next/static/chunks/three.js',
      '/_next/static/chunks/two.js',
    ]);
  });

  /** Three deployments made, the runtime cache given a new key as the second was. */
  async function deployedAcrossAReset(dir: string): Promise<readonly DeploymentBundle[]> {
    const builds: DeploymentBundle[] = [];
    for (const chunk of ['one', 'two', 'three']) {
      builds.push(buildWith(dir, chunk));
      const options = deployOptions(dir, { resetCacheKey: chunk === 'two' });

      await expect(runDeploy(options, account().credentials, account().io)).resolves.toBe(0);
    }
    return builds;
  }

  it('refuses a deployment named that was made before the cache key was reset', async () => {
    const dir = await deployableProject(PROJECT);
    const [one] = await deployedAcrossAReset(dir);
    const live = liveVersion(account());

    // Its Functions hold a token of the key before; nothing is switched.
    await expect(rollBack(dir, one?.deploymentId)).resolves.toBe(1);
    expect(liveVersion(account())).toBe(live);
    expect(held.errors).toStrictEqual([
      `upwind: ${String(one?.deploymentId)} was deployed before ${NAMES.cache}'s key was reset, and its Functions hold a token the cache no longer takes, so it cannot be gone back to; deploy its build again instead`,
    ]);
  });

  it('passes over a deployment made before the cache key was reset', async () => {
    const dir = await deployableProject(PROJECT);
    const [, two] = await deployedAcrossAReset(dir);

    // To the second, deployed under the key now — and no further.
    await expect(rollBack(dir)).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(two?.deploymentId);
    await expect(rollBack(dir)).resolves.toBe(1);
    expect(servedBy(account(), NAMES.edge)).toBe(two?.deploymentId);
    expect(held.errors).toStrictEqual([
      'upwind: no deployment before the live one can be rolled back to',
    ]);
  });

  it('keeps what it switched to where the agent cannot be given another key', async () => {
    const dir = await deployableProject(PROJECT);
    const { first } = await twoDeployed(dir);
    account().fake.fail({ method: 'PUT', path: `/workers/scripts/${NAMES.agent}/secrets` }, 400);

    await expect(rollBack(dir)).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(first.deploymentId);
    expect(held.warnings).toContainEqual(
      expect.stringContaining(
        `${NAMES.agent} may still take this rollback's key, until the next deploy or rollback replaces it`,
      ),
    );
  });

  it("goes back without the live deployment's files where its kept bundle cannot be read", async () => {
    const dir = await deployableProject(PROJECT);
    const { first, second } = await twoDeployed(dir);
    await spoilBundle(second.deploymentId, '{ "not": json');

    await expect(rollBack(dir)).resolves.toBe(0);
    expect(servedBy(account(), NAMES.edge)).toBe(first.deploymentId);
    expect(held.warnings).toContainEqual(
      `upwind: warning: the files of ${second.deploymentId}, the live deployment, are not carried over (its kept bundle is not JSON); its pages still open may lose them`,
    );

    const manifest = await servedManifest(account());

    expect(Object.keys(manifest.staticFiles ?? {})).toStrictEqual(['/_next/static/chunks/one.js']);
  });

  it.each([
    { kept: 'not JSON', bytes: '{ "not": json', why: 'its kept bundle is not JSON' },
    {
      kept: 'no bundle by its schema',
      bytes: JSON.stringify({ v: 999 }),
      why: 'its kept bundle is not a deployment bundle this version reads',
    },
  ])(
    'passes over a deployment whose kept bundle is $kept, and refuses it named',
    async ({ bytes, why }) => {
      const dir = await deployableProject(PROJECT);
      const [one, two] = await threeDeployed(dir);
      await spoilBundle(two?.deploymentId, bytes);
      const refused = `publishing ${String(two?.deploymentId)} again is refused (${why}), so it cannot be gone back to`;

      await expect(rollBack(dir)).resolves.toBe(0);
      expect(servedBy(account(), NAMES.edge)).toBe(one?.deploymentId);
      expect(held.warnings).toContainEqual(expect.stringContaining(refused));

      // Named, it is refused, saying why, and nothing is switched.
      const live = liveVersion(account());

      await expect(rollBack(dir, two?.deploymentId)).resolves.toBe(1);
      expect(liveVersion(account())).toBe(live);
      expect(held.errors).toStrictEqual([`upwind: ${refused}`]);
    },
  );

  it('stops where the agent fails as it stages, passing nothing over', async () => {
    const dir = await deployableProject(PROJECT);
    const [, two, three] = await threeDeployed(dir);
    const live = liveVersion(account());
    const route = `${AGENT_PATHS.blob}${encodeURIComponent(blobObjectKey(String(two?.staticFiles[0]?.blob.sha256)))}`;
    const answer = account().fake.workersDev.get(NAMES.agent);
    // The bucket failing as the second's script is read: no fault of the deployment's.
    account().fake.workersDev.set(NAMES.agent, (request, version, script) => {
      return answer === undefined ||
        (request.method === 'GET' && new URL(request.url).pathname === route)
        ? new Response('the bucket failed', { status: 500 })
        : answer(request, version, script);
    });

    await expect(
      runRollback({ projectDir: dir, to: undefined }, account().credentials, account().io),
    ).rejects.toThrow('the deploy agent answered 500');
    expect(liveVersion(account())).toBe(live);
    expect(servedBy(account(), NAMES.edge)).toBe(three?.deploymentId);
    expect(held.warnings).not.toContainEqual(expect.stringContaining('trying the deployment'));
  });
});
