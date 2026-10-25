import { parentPort, workerData } from 'node:worker_threads';

import { NativeAuthority } from './authority.ts';
import type { CacheAnswer, CacheCall, NativeCacheWorkerOptions } from './protocol.ts';

const port = parentPort;
if (port === null) throw new Error('native cache must run in a worker thread');
const authority = await NativeAuthority.open(workerData as NativeCacheWorkerOptions);
const pending = new Set<Promise<void>>();
const state = { closing: false };
const methods = new Set([
  'commit',
  'fail',
  'getData',
  'getTags',
  'heartbeat',
  'invalidate',
  'readArtifact',
  'readRecord',
  'setData',
  'startAttempt',
  'tagsDelta',
  'uploadArtifact',
  'uploadArtifacts',
]);

port.on('message', (call: CacheCall) => {
  const perform = async (): Promise<unknown> => {
    if (call.method === 'ready') return;
    if (call.method === 'close') {
      state.closing = true;
      await Promise.all(pending);
      await authority.close();
      return;
    }
    if (state.closing || !methods.has(call.method))
      throw new Error('native cache method is unavailable');
    const method = Reflect.get(authority, call.method) as (...args: readonly unknown[]) => unknown;
    return Reflect.apply(method, authority, call.args);
  };
  const answer = async (): Promise<void> => {
    try {
      const value = await perform();
      port.postMessage({ id: call.id, value } satisfies CacheAnswer);
    } catch (error) {
      port.postMessage({
        id: call.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      } satisfies CacheAnswer);
    }
  };
  const handled = answer();
  if (call.method !== 'close') {
    pending.add(handled);
    void handled.then(() => pending.delete(handled)).catch(() => pending.delete(handled));
  }
});
