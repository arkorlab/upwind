import assert from 'node:assert/strict';

import { completeNextStartup } from '../src/dev/next-startup.ts';
import { closeDevResources } from '../src/dev/shutdown.ts';
import { prepareLocalAi, type RemoteAiSession } from '../src/resources/local-ai.ts';
import { disposeLocalResources } from '../src/resources/shutdown.ts';

export async function checkConcurrentShutdown(): Promise<void> {
  const localStopped = Promise.withResolvers<undefined>();
  let remoteStarted = false;
  const closing = disposeLocalResources(() => localStopped.promise, {
    dispose: () => {
      remoteStarted = true;
      return Promise.resolve();
    },
  });
  assert.equal(remoteStarted, true, 'remote cleanup starts even while local shutdown is pending');
  localStopped.resolve(undefined);
  await closing;

  const remoteFailure = new Error('remote fixture failure');
  const storageFailure = new Error('storage fixture failure');
  await assert.rejects(
    disposeLocalResources(() => Promise.reject(storageFailure), {
      dispose: () => Promise.reject(remoteFailure),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [remoteFailure, storageFailure]);
      return true;
    },
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  let appClosed = false;
  console.warn = (message: string): void => {
    warnings.push(message);
  };
  try {
    await closeDevResources(
      () => Promise.reject(remoteFailure),
      () => {
        appClosed = true;
        return Promise.resolve();
      },
    );
    assert.equal(appClosed, true, 'remote cleanup rejection does not skip Next.js close');
    assert.deepEqual(warnings, ['upwind: failed to close local resources']);
    warnings.length = 0;
    await closeDevResources(
      () => Promise.resolve(),
      () => Promise.reject(new Error('application fixture secret')),
    );
    assert.deepEqual(warnings, ['upwind: failed to close Next.js']);
  } finally {
    console.warn = originalWarn;
  }
}

export async function checkFailedNextStartup(): Promise<void> {
  const failure = new Error('fixture startup failure');
  const drained = Promise.withResolvers<undefined>();
  const closeStarted = Promise.withResolvers<undefined>();
  let closed = false;
  const starting = completeNextStartup(
    () => {
      closed = true;
      closeStarted.resolve(undefined);
      return drained.promise;
    },
    () => Promise.reject(failure),
  );
  await closeStarted.promise;
  assert.equal(closed, true, 'failed preparation starts partial application cleanup');
  drained.resolve(undefined);
  await assert.rejects(starting, (error: unknown) => error === failure);

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string): void => {
    warnings.push(message);
  };
  try {
    await assert.rejects(
      completeNextStartup(
        () => Promise.reject(new Error('fixture cleanup secret')),
        () => Promise.reject(failure),
      ),
      (error: unknown) => error === failure,
    );
    assert.deepEqual(warnings, ['upwind: failed to close partially started Next.js']);
  } finally {
    console.warn = originalWarn;
  }
}

export async function checkPendingAiFactory(): Promise<void> {
  const factory = Promise.withResolvers<RemoteAiSession>();
  const factoryStarted = Promise.withResolvers<undefined>();
  const cleanupStarted = Promise.withResolvers<undefined>();
  const cleanupDrained = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  let disposed = 0;
  let completed = false;
  const preparing = prepareLocalAi(
    [],
    true,
    () => {
      factoryStarted.resolve(undefined);
      return factory.promise;
    },
    {
      signal: controller.signal,
      auth: { accountId: 'fixture-account', apiToken: 'fixture-token' },
    },
  );
  await factoryStarted.promise;
  controller.abort();
  const rejected = (async () => {
    await assert.rejects(async () => preparing, /cancelled/u);
    completed = true;
  })();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(completed, false, 'cancellation retains the still-pending session factory');
  factory.resolve({
    remoteProxyConnectionString: new URL('https://fixture.invalid') as never,
    ready: Promise.resolve(),
    dispose: () => {
      disposed += 1;
      cleanupStarted.resolve(undefined);
      return cleanupDrained.promise;
    },
  });
  await cleanupStarted.promise;
  assert.equal(completed, false, 'a late session must drain before startup is released');
  cleanupDrained.resolve(undefined);
  await rejected;
  assert.equal(disposed, 1);
}
