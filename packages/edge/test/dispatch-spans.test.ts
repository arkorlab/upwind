import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import type { EdgeRuntime } from '../src/edge-runtime.ts';
import { dispatchesMade, fetchUpstream } from '../src/handlers/upstream.ts';
import { standaloneRuntime } from '../src/standalone/index.ts';
import { navigation } from './helpers/site.ts';

const APP = { deploymentId: 'site', scriptName: 'main' };

function observing(isTraced = true) {
  const end = vi.fn<() => void>();
  const tracing: NonNullable<EdgeRuntime['tracing']> = {
    enterSpan: (_name, run) => run(),
    startActiveSpan: (_name, run) => run({ isTraced, end }),
  };
  return { tracing, end };
}

describe('native dispatch spans', () => {
  it('returns the actual host promise and closes the span at response headers', async () => {
    const { tracing, end } = observing();
    const pending = Promise.withResolvers<Response>();
    const runtime = standaloneRuntime(env, { tracing, dispatchApp: () => pending.promise });
    const answer = fetchUpstream(runtime, APP, navigation('/'));

    expect(answer).toBe(pending.promise);
    expect(dispatchesMade(answer)).toBe(1);
    expect(end).not.toHaveBeenCalled();

    const response = new Response('streamed');
    pending.resolve(response);

    await expect(answer).resolves.toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(end).toHaveBeenCalledExactlyOnceWith();
  });

  it('closes a rejected dispatch span and preserves the failure', async () => {
    const { tracing, end } = observing();
    const pending = Promise.withResolvers<Response>();
    const runtime = standaloneRuntime(env, { tracing, dispatchApp: () => pending.promise });
    const answer = fetchUpstream(runtime, APP, navigation('/'));
    const failure = new Error('binding failed');
    pending.reject(failure);

    await expect(answer).rejects.toBe(failure);
    expect(end).toHaveBeenCalledExactlyOnceWith();
  });

  it('ends the span on a synchronous throw and preserves the failure', async () => {
    const { tracing, end } = observing();
    const failure = new Error('synchronous binding failure');
    const runtime = standaloneRuntime(env, {
      tracing,
      dispatchApp: () => {
        throw failure;
      },
    });
    const answer = fetchUpstream(runtime, APP, navigation('/'));

    expect(end).toHaveBeenCalledExactlyOnceWith();
    await expect(answer).rejects.toBe(failure);
  });

  it('leaves an untraced pending operation without a settlement observer', async () => {
    const { tracing } = observing(false);
    const pending = Promise.withResolvers<Response>();
    const then = vi.spyOn(pending.promise, 'then');
    const runtime = standaloneRuntime(env, { tracing, dispatchApp: () => pending.promise });
    const answer = fetchUpstream(runtime, APP, navigation('/'));

    expect(answer).toBe(pending.promise);
    expect(then).not.toHaveBeenCalled();

    const response = new Response('untraced');
    pending.resolve(response);

    await expect(answer).resolves.toBe(response);
  });
});
