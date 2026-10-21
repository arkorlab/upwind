import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { createId } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import { type ActivateInput, activate, liveVersionOf } from '../../src/deploy/activate.ts';
import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import type { AccountScope, VersionShare } from '../../src/deploy/cloudflare/workers.ts';
import { READINESS_PATH } from '../../src/deploy/workers/protocol.ts';
import { type FakeCloudflare, fakeCloudflare, type FakeVersion } from './fake-cloudflare.ts';

const EDGE = 'shop-edge';
const ORIGIN = new URL(`https://${EDGE}.example.workers.dev/`);
const OVERRIDE = 'cloudflare-workers-version-overrides';
const OLD = { deploymentId: createId('dpl'), manifestId: 'a'.repeat(64) };
const NEW = { deploymentId: createId('dpl'), manifestId: 'b'.repeat(64) };
const EXPECTED = { ...NEW, versionId: 'v-new' };

/**
 * The edge on `workers.dev`, as Cloudflare routes a request to it: to the version it names
 * (`OVERRIDE`) where the edge's deployment holds that version, and to the live one otherwise —
 * without a word, either way. Each version answers readiness for the deployment it serves, and a
 * checked path as the test says.
 */
interface Edge {
  /** What each version serves. */
  readonly serves: Map<string, { readonly deploymentId: string; readonly manifestId: string }>;
  /** How a checked path is answered by a version. */
  check: (path: string, versionId: string) => Promise<Response>;
  /** The version an unnamed request reaches, given the one that takes the traffic. */
  unnamed: (live: string) => string;
  readonly seen: { readonly path: string; readonly override: string | null }[];
}

/** A version of the edge the fake API holds, which a deployment may name. */
function versionOf(id: string, number: number): FakeVersion {
  return { id, number, metadata: {}, modules: [], annotations: {} };
}

function edgeOf(fake: FakeCloudflare, shares: readonly VersionShare[]): Edge {
  fake.scripts.set(EDGE, {
    name: EDGE,
    versions: [versionOf('v-new', 2), versionOf('v-old', 1)],
    deployments: [{ id: 'deployment-0', versions: shares }],
    subdomain: { enabled: true, previews_enabled: false },
    migrationTag: undefined,
    secrets: new Map(),
  });
  return {
    serves: new Map([
      ['v-new', NEW],
      ['v-old', OLD],
    ]),
    check: () => Promise.resolve(new Response('ok')),
    unnamed: (live) => live,
    seen: [],
  };
}

function edgeFetch(fake: FakeCloudflare, edge: Edge): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    const override = request.headers.get(OVERRIDE);
    edge.seen.push({ path: pathname, override });
    const shares = fake.scripts.get(EDGE)?.deployments[0]?.versions ?? [];
    const live = shares.find((share) => share.percentage === 100)?.version_id ?? '';
    const named = /^[^=]+="([^"]+)"$/u.exec(override ?? '')?.[1];
    const versionId =
      named !== undefined && shares.some((share) => share.version_id === named)
        ? named
        : edge.unnamed(live);
    if (pathname === READINESS_PATH) {
      const served = edge.serves.get(versionId);
      return Response.json({ ...served, versionId, manifest: { kv: true, r2: true } });
    }
    return edge.check(pathname, versionId);
  };
}

function scopeOf(fake: FakeCloudflare): AccountScope {
  return {
    client: createCloudflareClient({
      apiToken: 'token',
      fetch: fake.fetch,
      sleep: () => Promise.resolve(),
    }),
    accountId: 'account-1',
  };
}

/** A clock that moves only when the run waits, as long as it waits. */
function clock(): { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> } {
  let at = 0;
  return {
    now: () => at,
    sleep: (ms) => {
      at += ms;
      return Promise.resolve();
    },
  };
}

function inputOf(
  fake: FakeCloudflare,
  edge: Edge,
  first = false,
): ActivateInput & { readonly now: () => number } {
  return {
    scope: scopeOf(fake),
    edge: EDGE,
    origin: ORIGIN,
    expected: EXPECTED,
    first,
    checks: ['/', '/about'],
    message: `upwind deploy ${NEW.deploymentId}`,
    fetch: edgeFetch(fake, edge),
    ...clock(),
  };
}

/** The edge's deployments, the newest first, as the versions each gives traffic to. */
function deploymentsOf(fake: FakeCloudflare): (readonly VersionShare[])[] {
  return (fake.scripts.get(EDGE)?.deployments ?? []).map((deployment) => deployment.versions);
}

function deploymentWrites(fake: FakeCloudflare): number {
  return fake.requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith(`/${EDGE}/deployments`),
  ).length;
}

describe("a project's first deployment", () => {
  it('is live once it answers as itself, and every path it is checked on does', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [{ version_id: 'v-new', percentage: 100 }]);

    await expect(activate(inputOf(fake, edge, true))).resolves.toStrictEqual({ kind: 'live' });
    expect(deploymentWrites(fake)).toBe(0);
    expect(edge.seen.map((seen) => seen.override)).toStrictEqual([null, null, null]);
  });

  it('is unconfirmed where it does not answer as itself in time', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [{ version_id: 'v-new', percentage: 100 }]);
    edge.serves.delete('v-new');
    const input = inputOf(fake, edge, true);

    await expect(activate(input)).resolves.toStrictEqual({ kind: 'unconfirmed' });
    expect(input.now()).toBeGreaterThanOrEqual(90_000);
  });

  it('is said to fail where a path it is checked on fails', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [{ version_id: 'v-new', percentage: 100 }]);
    edge.check = (path) =>
      Promise.resolve(new Response('', { status: path === '/about' ? 500 : 200 }));

    await expect(activate(inputOf(fake, edge, true))).resolves.toStrictEqual({
      kind: 'failing',
      reasons: ['/about was answered with 500'],
    });
  });
});

describe('a later deployment', () => {
  it('is checked by name beside the live version, and then given all the traffic', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [{ version_id: 'v-old', percentage: 100 }]);

    await expect(activate(inputOf(fake, edge))).resolves.toStrictEqual({ kind: 'live' });
    expect(deploymentsOf(fake)).toStrictEqual([
      [{ version_id: 'v-new', percentage: 100 }],
      [
        { version_id: 'v-old', percentage: 100 },
        { version_id: 'v-new', percentage: 0 },
      ],
      [{ version_id: 'v-old', percentage: 100 }],
    ]);

    const named = `${EDGE}="v-new"`;

    // Readiness and both paths by name, then readiness unnamed, once the version is live.
    expect(edge.seen).toStrictEqual([
      { path: READINESS_PATH, override: named },
      { path: '/', override: named },
      { path: '/about', override: named },
      { path: READINESS_PATH, override: null },
    ]);
  });

  it('leaves the live version all the traffic where a path fails through the new one', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [{ version_id: 'v-old', percentage: 100 }]);
    edge.check = (path, versionId) => {
      if (versionId === 'v-new' && path === '/') {
        return Promise.resolve(
          new Response('', {
            status: 404,
            headers: { [EDGE_DEBUG_HEADER]: 'error;reason=no-pointer' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: versionId === 'v-new' ? 503 : 200 }));
    };

    await expect(activate(inputOf(fake, edge))).resolves.toStrictEqual({
      kind: 'kept',
      versionId: 'v-old',
      reasons: ['/ was answered with no deployment', '/about was answered with 503'],
    });
    expect(deploymentsOf(fake)[0]).toStrictEqual([{ version_id: 'v-old', percentage: 100 }]);
  });

  it('leaves the live version all the traffic where the new one never answers as itself', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [{ version_id: 'v-old', percentage: 100 }]);
    // Answering for the deployment before: the pointer it was uploaded with is not this one's.
    edge.serves.set('v-new', OLD);

    await expect(activate(inputOf(fake, edge))).resolves.toStrictEqual({
      kind: 'kept',
      versionId: 'v-old',
      reasons: ['the new version did not answer as itself within 90 s'],
    });
    expect(deploymentsOf(fake)[0]).toStrictEqual([{ version_id: 'v-old', percentage: 100 }]);
  });

  it('switches nothing where the deployment changed while it was checked', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [{ version_id: 'v-old', percentage: 100 }]);
    const other = [{ version_id: 'v-other', percentage: 100 }];
    edge.check = (path) => {
      if (path === '/about') {
        // Somebody else's deployment, made between the check and the switch.
        fake.scripts.get(EDGE)?.deployments.unshift({ id: 'deployment-other', versions: other });
      }
      return Promise.resolve(new Response('ok'));
    };

    await expect(activate(inputOf(fake, edge))).resolves.toStrictEqual({
      kind: 'overtaken',
      reasons: [],
    });
    expect(deploymentsOf(fake)[0]).toStrictEqual(other);
    // The checking split, and nothing after it.
    expect(deploymentWrites(fake)).toBe(1);
  });

  it('puts nothing back where the deployment changed while failing checks ran', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [{ version_id: 'v-old', percentage: 100 }]);
    const rollback = [{ version_id: 'v-older', percentage: 100 }];
    edge.check = (path) => {
      if (path === '/about') {
        // A rollback somebody makes while this run's checks fail: it is theirs to keep.
        fake.scripts
          .get(EDGE)
          ?.deployments.unshift({ id: 'deployment-rollback', versions: rollback });
        return Promise.resolve(new Response('', { status: 500 }));
      }
      return Promise.resolve(new Response('ok'));
    };

    await expect(activate(inputOf(fake, edge))).resolves.toStrictEqual({
      kind: 'overtaken',
      reasons: ['/about was answered with 500'],
    });
    expect(deploymentsOf(fake)[0]).toStrictEqual(rollback);
    expect(deploymentWrites(fake)).toBe(1);
  });

  it('is unconfirmed where it does not answer unnamed once it has the traffic', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [{ version_id: 'v-old', percentage: 100 }]);
    // Every place still sends an unnamed request to the version before.
    edge.unnamed = () => 'v-old';

    await expect(activate(inputOf(fake, edge))).resolves.toStrictEqual({ kind: 'unconfirmed' });
    expect(deploymentsOf(fake)[0]).toStrictEqual([{ version_id: 'v-new', percentage: 100 }]);
  });

  it('switches nothing for a version that takes all the traffic already', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [{ version_id: 'v-new', percentage: 100 }]);

    await expect(activate(inputOf(fake, edge))).resolves.toStrictEqual({ kind: 'live' });
    expect(deploymentWrites(fake)).toBe(0);
  });

  it('switches from a live version beside one a stopped run left with no traffic', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [
      { version_id: 'v-old', percentage: 100 },
      { version_id: 'v-stopped', percentage: 0 },
    ]);

    await expect(activate(inputOf(fake, edge))).resolves.toStrictEqual({ kind: 'live' });
    expect(deploymentsOf(fake)[1]).toStrictEqual([
      { version_id: 'v-old', percentage: 100 },
      { version_id: 'v-new', percentage: 0 },
    ]);
  });

  it('is said to fail where a path is not answered at all', async () => {
    const fake = fakeCloudflare();
    const edge = edgeOf(fake, [{ version_id: 'v-old', percentage: 100 }]);
    edge.check = (path) => {
      return path === '/about'
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(new Response('ok'));
    };

    await expect(activate(inputOf(fake, edge))).resolves.toStrictEqual({
      kind: 'kept',
      versionId: 'v-old',
      reasons: ['/about was not answered: fetch failed'],
    });
  });
});

describe('the version that takes the traffic', () => {
  it('is the one at all of it, beside versions at none', () => {
    expect(liveVersionOf({ id: 'd', versions: [{ version_id: 'a', percentage: 100 }] })).toBe('a');
    expect(
      liveVersionOf({
        id: 'd',
        versions: [
          { version_id: 'b', percentage: 0 },
          { version_id: 'a', percentage: 100 },
        ],
      }),
    ).toBe('a');
  });

  it('is none where the traffic is split, or the edge has no deployment', () => {
    expect(() => {
      return liveVersionOf({
        id: 'd',
        versions: [
          { version_id: 'a', percentage: 50 },
          { version_id: 'b', percentage: 50 },
        ],
      });
    }).toThrow("the edge's traffic is split (a at 50%, b at 50%)");
    expect(() => liveVersionOf(undefined)).toThrow("the edge's traffic is split ()");
  });
});
