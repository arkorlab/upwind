import type { TaskGroup } from '@stayingupwind/runtime/native';

interface NativeWork {
  readonly requests: Pick<TaskGroup, 'drain'>;
  readonly tasks: Pick<TaskGroup, 'drain'>;
  readonly closeBridge: (timeoutMs: number) => Promise<boolean>;
  readonly remaining: () => number;
}

/** Drain every producer of background work before the host closes its cache and other resources. */
export async function drainNativeWork(work: NativeWork): Promise<boolean> {
  const requests = await work.requests.drain(work.remaining());
  const tasks = await work.tasks.drain(work.remaining());
  const bridge = await work.closeBridge(work.remaining());
  // A disconnected GET can still register waitUntil while its handler is held by the bridge.
  // Once the bridge has drained, those handlers can no longer add work to the host's group.
  const finalTasks = await work.tasks.drain(work.remaining());
  return requests && tasks && bridge && finalTasks;
}
