import { type EdgePointer, edgePointerSchema } from '@stayingupwind/host/delivery';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { createPointerReader } from '../src/preview/pointer.ts';
import { standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

/**
 * How the edge reads a host's kind of pointer (`createPointerReader`), and what it tells the kind's
 * observer of a live read: told so that the telling never touches the read.
 */

const KEY = 'pointer:observed';

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
