import { describe, expect, it } from 'vitest';

import {
  builtinDeliveryPolicies,
  builtinDeliveryPolicy,
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
  type DeliveryPolicy,
  deliveryPolicySchema,
  edgePointerSchema,
  type RuntimeCacheSettings,
  runtimeCacheOf,
} from '../src/delivery/policy.ts';
import { resolvePolicy, type StrategyRegistry } from '../src/delivery/strategy.ts';
import { kvManifestKey, kvPolicyKey } from '../src/storage/keys.ts';

const noShell = { getShell: () => Promise.resolve(undefined) };
const noAsset = {
  handle: () =>
    Promise.resolve({ response: new Response(null), admitted: false, hit: false, subrequests: 1 }),
};
const registry: StrategyRegistry<undefined> = {
  shell: {
    kv: { id: 'kv', ...noShell },
    r2: { id: 'r2', ...noShell },
    'static-assets': { id: 'static-assets', ...noShell },
  },
  assets: {
    'cache-api-readthrough': { id: 'cache-api-readthrough', ...noAsset },
    passthrough: { id: 'passthrough', ...noAsset },
    'r2-mirror': { id: 'r2-mirror', ...noAsset },
  },
};

describe('resolvePolicy', () => {
  it('binds a policy to the strategies its backends name', () => {
    const resolved = resolvePolicy(registry, {
      ...DEFAULT_DELIVERY_POLICY,
      shell: { ...DEFAULT_DELIVERY_POLICY.shell, backend: 'r2' },
      assets: { ...DEFAULT_DELIVERY_POLICY.assets, backend: 'cache-api-readthrough' },
    });

    expect(resolved.shell.id).toBe('r2');
    expect(resolved.assets.id).toBe('cache-api-readthrough');
  });

  /**
   * Each backend is the strategy that names itself so, which the type holds a registry to: a
   * strategy filed under another backend's name would report the wrong backend once resolved.
   */
  it('files each strategy under the backend it names itself', () => {
    const misfiled: StrategyRegistry<undefined> = {
      ...registry,
      shell: {
        ...registry.shell,
        // @ts-expect-error -- `r2`'s strategy under `kv`.
        kv: { id: 'r2', ...noShell },
      },
    };

    expect(resolvePolicy(misfiled, DEFAULT_DELIVERY_POLICY).shell.id).toBe('r2');
  });
});

describe('deliveryPolicySchema', () => {
  it('accepts the default policy and pointer shapes', () => {
    expect(deliveryPolicySchema.parse(DEFAULT_DELIVERY_POLICY)).toStrictEqual(
      DEFAULT_DELIVERY_POLICY,
    );

    expect(
      edgePointerSchema.parse({
        v: 1,
        projectId: 'project_1111111111111111111Z',
        originHost: 'example.com',
        mode: 'edge',
        policyId: 'p',
        updatedAt: '2026-09-15T00:00:00.000Z',
      }).mode,
    ).toBe('edge');
  });

  it('reads the fields the edge serves by, and no field of a host’s own', () => {
    expect(Object.keys(edgePointerSchema.shape)).toStrictEqual([
      'v',
      'projectId',
      'originHost',
      'mode',
      'reason',
      'manifestId',
      'requiresGate',
      'policyId',
      'selectedPolicy',
      'deployment',
      'cspNonce',
      'cspNonceMode',
      'cspStrictDynamic',
      'cacheApi',
      'app',
      'demotedRoutes',
      'updatedAt',
    ]);
  });

  it('derives deterministic kv keys', () => {
    expect(kvManifestKey('m1')).toBe('manifest:m1');
    expect(kvPolicyKey('p1')).toBe('policy:p1');
  });
});

describe('the policy an application is served under', () => {
  /**
   * The deadline is the edge's, not the middleware's: missing it does not shorten the request, it
   * hands the whole document to the deployment's Worker, which is the slow path this exists to
   * keep documents off.
   *
   * A middleware bundle of tens of mebibytes can take some 400 ms on every request, not only on a
   * cold start. So the budget is held to a multiple of that, not to a margin over a cold start that
   * is no longer the exception.
   */
  it('gives the middleware several times what a large bundle takes', () => {
    const LARGE_MIDDLEWARE_MS = 400;

    // A stored document is read by id, so a budget that changed is a policy of its own.
    expect(DEFAULT_DELIVERY_POLICY.id).toBe('paas-v5');

    expect(DEFAULT_DELIVERY_POLICY.middleware.timeoutMs).toBeGreaterThan(LARGE_MIDDLEWARE_MS * 4);
  });

  /**
   * And what it replaced keeps the budget it had. A project's pointer names `paas-v4` until it
   * deploys again, and what that id meant does not change under it.
   */
  it('leaves the budget of the default it replaced where it was', () => {
    const retired = builtinDeliveryPolicy('paas-v4');

    expect(retired?.middleware.timeoutMs).toBe(1000);
    expect(retired?.runtimeCache?.cacheApiMaxAgeMs).toBe(
      DEFAULT_DELIVERY_POLICY.runtimeCache?.cacheApiMaxAgeMs,
    );
  });

  /**
   * A policy of a host's own may leave the budget out. It is given the default policy's, so a cold
   * middleware isolate is not timed out into a full render under a smaller one.
   */
  it('gives a policy that states no middleware budget the default policy’s', () => {
    const withoutBudget: Record<string, unknown> = { ...DEFAULT_DELIVERY_POLICY };
    delete withoutBudget['middleware'];

    const parsed = deliveryPolicySchema.parse({ ...withoutBudget, id: 'no-budget' });
    const again = deliveryPolicySchema.parse({ ...withoutBudget, id: 'no-budget-again' });
    const defaults = DEFAULT_DELIVERY_POLICY.middleware;

    expect(parsed.middleware).toStrictEqual(defaults);
    // A default of its own for each: no parse hands another the same object to change.
    expect(parsed.middleware).not.toBe(again.middleware);
  });

  /**
   * KV keeps a record in a data center for its `cacheTtl`, 30 s at the least. A copy that lived no
   * longer would be gone whenever KV's was, and would answer nothing KV had not answered as fast.
   */
  it("keeps a data center's copy of a record for longer than KV's own cache there", () => {
    const KV_CACHE_TTL_MS = 30_000;

    expect(DEFAULT_DELIVERY_POLICY.runtimeCache?.cacheApiMaxAgeMs).toBeGreaterThan(KV_CACHE_TTL_MS);
  });

  it('reads a policy stored before the copies existed as keeping none', () => {
    // What `paas-v3` was stored as: every setting the schema had then, and nothing else.
    const stored = {
      generations: 'on',
      holdMs: 5000,
      regenerateCooldownMs: 5000,
      concreteUpgrade: false,
    } as const;
    const parsed = deliveryPolicySchema.parse({ ...DEFAULT_DELIVERY_POLICY, runtimeCache: stored });

    expect(parsed.runtimeCache?.cacheApiMaxAgeMs).toBeUndefined();
  });

  /**
   * A pointer written under the default this one replaced names it until its project deploys
   * again, and one that no deployment stored a document for is served that policy as it was: the
   * same in everything but the copies, which it keeps none of.
   */
  it('keeps the default it replaced as a built-in, as it was', () => {
    const retired = builtinDeliveryPolicy('paas-v3');

    expect(builtinDeliveryPolicy(DEFAULT_DELIVERY_POLICY.id)).toBe(DEFAULT_DELIVERY_POLICY);
    expect(retired).toStrictEqual({
      ...DEFAULT_DELIVERY_POLICY,
      id: 'paas-v3',
      middleware: { ...DEFAULT_DELIVERY_POLICY.middleware, timeoutMs: 1000 },
      runtimeCache: { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'on' },
    });
    expect(deliveryPolicySchema.parse(retired)).toStrictEqual(retired);
    expect(builtinDeliveryPolicy('site-default')).toBeUndefined();
  });
});

/** Whether `value`, and every object it holds, is frozen. */
function isFrozenThrough(value: unknown): boolean {
  return (
    typeof value !== 'object' ||
    value === null ||
    (Object.isFrozen(value) && Object.values(value).every((held) => isFrozenThrough(held)))
  );
}

describe('the built-in policies', () => {
  /**
   * Each is one object handed to every caller, and the retired ones share with the default what
   * they did not change: a change made to one would be every other caller's policy after it.
   */
  it('are frozen through, nested parts and all', () => {
    expect(builtinDeliveryPolicies().map((policy) => isFrozenThrough(policy))).toStrictEqual([
      true,
      true,
      true,
    ]);
    expect(isFrozenThrough(builtinDeliveryPolicy('paas-v4') ?? {})).toBe(true);
  });

  it('are changed by no caller for the next', () => {
    expect(() => {
      // @ts-expect-error -- a built-in policy's parts are read-only, as the object is frozen.
      DEFAULT_DELIVERY_POLICY.shell.backend = 'r2';
    }).toThrow(TypeError);
    expect(builtinDeliveryPolicy(DEFAULT_DELIVERY_POLICY.id)?.shell.backend).toBe('kv');
  });
});

describe('the runtime cache settings of a policy that states none', () => {
  const stating: DeliveryPolicy = {
    id: 'states-none',
    shell: DEFAULT_DELIVERY_POLICY.shell,
    assets: DEFAULT_DELIVERY_POLICY.assets,
    continuation: DEFAULT_DELIVERY_POLICY.continuation,
    middleware: DEFAULT_DELIVERY_POLICY.middleware,
  };

  it('are the defaults', () => {
    expect(runtimeCacheOf(stating)).toStrictEqual(DEFAULT_RUNTIME_CACHE_SETTINGS);
  });

  /** One object is handed to every caller whose policy states none. */
  it('are defaults no caller can change for the next', () => {
    const settings = runtimeCacheOf(stating) as RuntimeCacheSettings;

    expect(() => {
      settings.generations = 'on';
    }).toThrow(TypeError);
    expect(runtimeCacheOf(stating).generations).toBe('off');
  });
});

describe('the pointer', () => {
  const pointer = {
    v: 1,
    projectId: 'project_1111111111111111111Z',
    originHost: 'example.com',
    mode: 'edge',
    policyId: 'p',
    updatedAt: '2026-09-15T00:00:00.000Z',
  } as const;

  it("carries a project's copies turned off, and reads a pointer that says nothing as on", () => {
    expect(edgePointerSchema.parse({ ...pointer, cacheApi: false }).cacheApi).toBe(false);
    expect(edgePointerSchema.parse(pointer).cacheApi).toBeUndefined();
  });

  /**
   * A pointer the edge cannot parse is no pointer at all, so the list takes more routes than a
   * writer keeps to today: a bound raised later must not be refused by an edge from before.
   */
  it('carries the routes it demotes, however many', () => {
    const until = '2026-09-30T00:00:00.000Z';
    const route = (index: number) => ({ pathname: `/r/${String(index)}`, until });
    const demotedRoutes = Array.from({ length: 200 }, (_, index) => route(index));

    expect(edgePointerSchema.parse({ ...pointer, demotedRoutes }).demotedRoutes).toHaveLength(200);
    expect(edgePointerSchema.parse(pointer).demotedRoutes).toBeUndefined();
    expect(
      edgePointerSchema.safeParse({
        ...pointer,
        demotedRoutes: [{ pathname: '/', until: 'soon' }],
      }).success,
    ).toBe(false);
  });
});

describe('policy id', () => {
  /**
   * The id travels in the `;`-delimited `x-arkor-edge` header and validation splits that header to
   * ask which policy answered. One carrying a separator could never match its own response, so a
   * policy under one would be accepted and then fail every validation it was put through.
   */
  it('refuses an id that could not survive the debug header', () => {
    const spec = { ...DEFAULT_DELIVERY_POLICY };

    expect(deliveryPolicySchema.safeParse({ ...spec, id: 'v1-beta.2_x' }).success).toBe(true);
    expect(deliveryPolicySchema.safeParse({ ...spec, id: 'foo;bar' }).success).toBe(false);
    expect(deliveryPolicySchema.safeParse({ ...spec, id: 'has space' }).success).toBe(false);
    expect(deliveryPolicySchema.safeParse({ ...spec, id: '' }).success).toBe(false);
    expect(deliveryPolicySchema.safeParse({ ...spec, id: 'x'.repeat(65) }).success).toBe(false);
  });
});
