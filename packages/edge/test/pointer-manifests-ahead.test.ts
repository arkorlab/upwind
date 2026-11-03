import { type EdgePointer, edgePointerSchema } from '@stayingupwind/host/delivery';
import { kvManifestKey } from '@stayingupwind/host/storage';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeBindings } from '../src/bindings.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { getManifest } from '../src/preview/manifest.ts';
import { createPointerReader, type PointerKind } from '../src/preview/pointer.ts';
import { standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

/**
 * What a refreshed pointer is read ahead with before it is adopted (`readAhead`): beside its own
 * manifest and its policy, the manifests its kind names for the other deployments it sends paths to
 * (`PointerKind.manifestsAhead`).
 */

/** Past the isolate's hold on a pointer read, after which a live request is served it stale. */
const PAST_TTL_MS = 10_001;
const RELEASED_AT = '2026-10-28T00:00:00.000Z';

function parsed(raw: unknown): EdgePointer | undefined {
  const pointer = edgePointerSchema.safeParse(raw);
  return pointer.success ? pointer.data : undefined;
}

type Kind = Omit<PointerKind<EdgePointer, never>, 'parse'>;

/**
 * An isolate holding a site's pointer past its TTL, while KV names the site's next release: the
 * deployment's own manifest, and another deployment's beside it, each seeded as a deploy leaves
 * them. Every key KV is asked for is listed (`asked`); KV's answer for one held back keeps the read
 * of it out until it is let go (`holdBack`). `refresh` serves the stale pointer to a live request
 * and returns once what that request left behind it has ended.
 */
async function releasing(kind: Kind) {
  const site = await seedSite({ document: pprDocument() });
  const other = await seedSite({ document: pprDocument(), pathname: '/other' });
  const key = `pointer:${crypto.randomUUID()}`;
  const served = site.pointer;
  const next: EdgePointer = { ...site.pointer, updatedAt: RELEASED_AT };
  let named: EdgePointer = served;
  const asked: string[] = [];
  const heldBack = new Map<string, Promise<void>>();
  const kv = env.EDGE_STATE as unknown as {
    get(name: string, options?: unknown): Promise<unknown>;
  };
  const get = async (name: string, options?: unknown): Promise<unknown> => {
    asked.push(name);
    if (name === key) return named;
    await heldBack.get(name);
    return kv.get(name, options);
  };
  const bindings: EdgeBindings = { ...env, EDGE_STATE: { get } as unknown as KVNamespace };
  const clock = { now: Date.now() };
  const runtime = standaloneRuntime(env, { memory: createEdgeMemory(() => clock.now) });
  const reader = createPointerReader<EdgePointer, never>({ parse: parsed, ...kind });
  const kept: Promise<void>[] = [];
  const live = {
    holdRefresh: (work: Promise<void>): void => {
      kept.push(work);
    },
  };
  await reader.get(bindings, runtime, key, live);
  named = next;
  clock.now += PAST_TTL_MS;
  const holdBack = (manifestId: string): (() => void) => {
    const released = Promise.withResolvers<undefined>();
    heldBack.set(kvManifestKey(manifestId), released.promise);
    return () => {
      released.resolve(undefined);
    };
  };
  const refresh = async (): Promise<void> => {
    await reader.get(bindings, runtime, key, live);
    await Promise.all(kept);
  };
  const adopted = (): string | undefined =>
    runtime.memory.pointers.peek(key)?.value.pointer?.updatedAt;
  return {
    own: site.manifestId,
    extra: other.manifestId,
    served,
    asked,
    bindings,
    runtime,
    holdBack,
    refresh,
    adopted,
  };
}

describe('a refreshed pointer whose kind names more manifests than its own', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads them with its own before it is adopted, each once', async () => {
    const manifestsAhead = vi.fn<NonNullable<Kind['manifestsAhead']>>();
    const release = await releasing({ manifestsAhead });
    manifestsAhead.mockReturnValue([release.extra, release.own, release.extra]);
    const letGo = release.holdBack(release.extra);
    const refreshed = release.refresh();

    await vi.waitFor(() => {
      expect(release.asked).toContain(kvManifestKey(release.extra));
    });

    // The other deployment's manifest is still being read, and the pointer served stands meanwhile.
    expect(release.adopted()).toBe(release.served.updatedAt);

    letGo();
    await refreshed;

    expect(release.adopted()).toBe(RELEASED_AT);
    expect(release.runtime.memory.manifests.has(release.extra)).toBe(true);
    expect(
      [release.own, release.extra].map(
        (id) => release.asked.filter((name) => name === kvManifestKey(id)).length,
      ),
    ).toStrictEqual([1, 1]);
    expect(manifestsAhead).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ updatedAt: release.served.updatedAt }),
      expect.objectContaining({ updatedAt: RELEASED_AT }),
      expect.any(Function),
    );
  });

  it('is told which it holds already, and reads none of those again, named or not', async () => {
    const seen: boolean[] = [];
    let extra = '';
    const release = await releasing({
      // Named although held: what the isolate holds is not read again, whatever the hook names —
      // the reader's to keep, not each hook's (cubic).
      manifestsAhead: (_served, _next, held) => {
        seen.push(held(extra), held('f'.repeat(64)));
        return [extra];
      },
    });
    ({ extra } = release);
    // Held already: a request routed to the other deployment read it before.
    await getManifest(release.bindings, release.runtime, extra);
    release.asked.length = 0;

    await release.refresh();

    expect(seen).toStrictEqual([true, false]);
    expect(release.asked).not.toContain(kvManifestKey(extra));
    expect(release.adopted()).toBe(RELEASED_AT);
  });

  it('reads only its own where its kind names nothing', async () => {
    const release = await releasing({});

    await release.refresh();

    expect(release.asked).toContain(kvManifestKey(release.own));
    expect(release.asked).not.toContain(kvManifestKey(release.extra));
    expect(release.runtime.memory.manifests.has(release.extra)).toBe(false);
    expect(release.adopted()).toBe(RELEASED_AT);
  });

  it('is adopted with its own read ahead where the kind throws, which is logged', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Read below, not printed.
    });
    const release = await releasing({
      manifestsAhead: () => {
        throw new Error('the kind broke');
      },
    });

    await release.refresh();

    expect(release.adopted()).toBe(RELEASED_AT);
    expect(release.runtime.memory.manifests.has(release.own)).toBe(true);
    expect(release.asked).not.toContain(kvManifestKey(release.extra));
    expect(warned).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'warn',
        message: 'the host pointer kind threw',
        asked: 'manifestsAhead',
        detail: 'the kind broke',
      }),
    );
  });

  it('reads none of what a kind named before it threw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // Logged, as above.
    });
    let extra = '';
    const release = await releasing({
      // An iterable the type does not admit, which a kind written in JavaScript could return.
      manifestsAhead: () => {
        return (function* names() {
          yield extra;
          throw new Error('the kind broke partway');
        })() as unknown as readonly string[];
      },
    });
    ({ extra } = release);

    await release.refresh();

    expect(release.adopted()).toBe(RELEASED_AT);
    expect(release.asked).not.toContain(kvManifestKey(extra));
    expect(release.runtime.memory.manifests.has(extra)).toBe(false);
  });
});
