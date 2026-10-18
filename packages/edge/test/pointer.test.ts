import { type EdgePointer, edgePointerSchema } from '@stayingupwind/host/delivery';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { createEdgeMemory, rewriteSeenKey, routeSuspectKey } from '../src/memory/caches.ts';
import { createPointerReader } from '../src/preview/pointer.ts';
import { manifestStateFromPointer } from '../src/preview/state.ts';
import { standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

/**
 * How the edge reads a host's kind of pointer (`createPointerReader`), and what it tells the kind's
 * observer of a live read: told so that the telling never touches the read.
 */

const KEY = 'pointer:observed';
const STALE_KEY = 'pointer:observed-stale';
/** Past the isolate's hold on a pointer read, after which a live request is served it stale. */
const PAST_TTL_MS = 10_001;

function parsed(raw: unknown): EdgePointer | undefined {
  const pointer = edgePointerSchema.safeParse(raw);
  return pointer.success ? pointer.data : undefined;
}

describe('a pointer read cold for a live request', () => {
  it('answers with the pointer whatever its observer does with the read', async () => {
    const { pointer } = await seedSite({ document: pprDocument() });
    await env.EDGE_STATE.put(KEY, JSON.stringify(pointer));
    const reader = createPointerReader<EdgePointer, string>({
      parse: parsed,
      observer: {
        cold: () => {
          throw new Error('the observer broke');
        },
        stale: () => {
          // A cold read is all this test makes.
        },
      },
    });
    const runtime = standaloneRuntime(env, { memory: createEdgeMemory(() => Date.now()) });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Read below, not printed.
    });
    try {
      const read = await reader.get(env, runtime, KEY, {
        holdRefresh: () => {
          // Nothing is read behind a cold read.
        },
        observer: 'a live request',
      });

      expect(read.kind === 'found' ? read.value.projectId : undefined).toBe(pointer.projectId);
      expect(warned).toHaveBeenCalledWith(
        JSON.stringify({
          level: 'warn',
          message: 'the host observer threw',
          told: 'cold',
          detail: 'the observer broke',
        }),
      );
    } finally {
      warned.mockRestore();
    }
  });
});

describe('a pointer served past its TTL for a live request', () => {
  /**
   * The refresh read behind the answer tells the observer what it found, as a cold read does, in a
   * `try` of its own: what the observer throws, or rejects with, is logged, and the work the request
   * keeps behind its answer ends all the same, rejecting nothing it is handed to (Sentry,
   * upwind#179).
   */
  it.each([
    [
      'throws',
      (): never => {
        throw new Error('the observer broke');
      },
    ],
    ['rejects', (): Promise<never> => Promise.reject(new Error('the observer broke'))],
  ])('ends the refresh behind the answer whose observer %s', async (_, stale) => {
    const { pointer } = await seedSite({ document: pprDocument() });
    await env.EDGE_STATE.put(STALE_KEY, JSON.stringify(pointer));
    const reader = createPointerReader<EdgePointer, string>({
      parse: parsed,
      observer: {
        cold: () => {
          // The read the stale one refreshes, which this test does not look at.
        },
        stale,
      },
    });
    const clock = { now: Date.now() };
    const runtime = standaloneRuntime(env, { memory: createEdgeMemory(() => clock.now) });
    const kept: Promise<void>[] = [];
    const live = {
      holdRefresh: (work: Promise<void>): void => {
        kept.push(work);
      },
      observer: 'a live request',
    };
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Read below, not printed.
    });
    try {
      await reader.get(env, runtime, STALE_KEY, live);
      clock.now += PAST_TTL_MS;
      const read = await reader.get(env, runtime, STALE_KEY, live);

      expect(read.kind === 'found' ? read.value.projectId : undefined).toBe(pointer.projectId);
      await expect(kept[0]).resolves.toBeUndefined();
      expect(warned).toHaveBeenCalledWith(
        JSON.stringify({
          level: 'warn',
          message: 'the host observer threw',
          told: 'stale',
          detail: 'the observer broke',
        }),
      );
    } finally {
      warned.mockRestore();
    }
  });
});

const COLLIDING_IDENTITIES = [
  [
    ['a', 'b:c', '/x'],
    ['a:b', 'c', '/x'],
  ],
  [
    ['a/b', 'c:d', '/x'],
    ['a/b:c', 'd', '/x'],
  ],
  [
    ['😀', 'é:雪', '/a:/b'],
    ['😀:é', '雪', '/a:/b'],
  ],
  [
    ['p', 'm:/a', '/b'],
    ['p', 'm', '/a:/b'],
  ],
] as const;

describe('a suspect route belongs to its composed project and manifest', () => {
  it.each(COLLIDING_IDENTITIES)(
    'keeps distinct identifier tuples apart: %j and %j',
    (first, second) => {
      const memory = createEdgeMemory(() => 0);
      memory.suspects.set(routeSuspectKey(first[0], first[1], first[2]), true);

      expect(memory.suspects.get(routeSuspectKey(first[0], first[1], first[2]))).toBe(true);
      expect(memory.suspects.get(routeSuspectKey(second[0], second[1], second[2]))).toBeUndefined();
    },
  );

  it.each(COLLIDING_IDENTITIES)(
    'keeps the other pointer on the edge: %j and %j',
    async (first, second) => {
      const site = await seedSite({ document: pprDocument() });
      const runtime = standaloneRuntime(env, { memory: createEdgeMemory(() => 0) });
      const state = (identity: readonly [string, string, string]) => {
        const [projectId, manifestId, pathname] = identity;
        const pointer = { ...site.pointer, projectId, manifestId };
        return manifestStateFromPointer({
          runtime,
          pointer,
          pathname,
          stored: { kind: 'found', value: { ...site.manifest, projectId } },
          privateDelivery: false,
          cspReportingPath: undefined,
        });
      };
      runtime.memory.suspects.set(routeSuspectKey(first[0], first[1], first[2]), true);

      expect(state(first).mode).toBe('passthrough');
      expect(state(second).mode).toBe('edge');
    },
  );

  it('retains ordinary route isolation and the existing expiry', async () => {
    const site = await seedSite({ document: pprDocument() });
    const clock = { now: 0 };
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => clock.now),
      now: () => clock.now,
    });
    const state = (pathname: string) => {
      return manifestStateFromPointer({
        runtime,
        pointer: site.pointer,
        pathname,
        stored: { kind: 'found', value: site.manifest },
        privateDelivery: false,
        cspReportingPath: undefined,
      });
    };
    const key = routeSuspectKey(site.pointer.projectId, site.manifestId, '/x');
    runtime.memory.suspects.set(key, true);

    expect(state('/x').mode).toBe('passthrough');
    expect(state('/y').mode).toBe('edge');

    clock.now = 3_600_001;

    expect(state('/x').mode).toBe('edge');
  });

  it('keeps Unicode spellings and surrogate identifiers opaque', () => {
    const keys = [
      routeSuspectKey('é', 'm', '/x'),
      routeSuspectKey('é', 'm', '/x'),
      routeSuspectKey('\u{D800}', 'm', '/x'),
      routeSuspectKey('\u{D801}', 'm', '/x'),
      routeSuspectKey('/', 'm', '/x'),
      routeSuspectKey('%2F', 'm', '/x'),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('middleware lookahead belongs to its manifest and pathname', () => {
  it.each([
    ['a:/b', '/c', 'a', '/b:/c'],
    ['雪:/x', '/y', '雪', '/x:/y'],
  ])('keeps %s plus %s apart from %s plus %s', (firstId, firstPath, secondId, secondPath) => {
    const memory = createEdgeMemory(() => 0);
    const seen = { kind: 'unserved' } as const;
    memory.rewritesSeen.set(rewriteSeenKey(firstId, firstPath), seen);

    expect(memory.rewritesSeen.get(rewriteSeenKey(firstId, firstPath))).toBe(seen);
    expect(memory.rewritesSeen.get(rewriteSeenKey(secondId, secondPath))).toBeUndefined();
    expect(memory.rewritesSeen.get(rewriteSeenKey(firstId, `${firstPath}/other`))).toBeUndefined();
  });
});
