import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DurableObjectDeclaration } from '@stayingupwind/core/bundle';
import { UPWIND_DURABLE_OBJECTS_ENV } from '@stayingupwind/core/paas';
import { Miniflare } from 'miniflare';

import { d1, durableObject } from '../../sdk/src/named.ts';
import { type LocalResources, startLocalResources } from '../src/resources/local.ts';

const CLEANUP_TIMEOUT_MS = 3000;

/** A real ready runtime with a transient storage probe failure must never lose just its owners. */
export async function checkProbeFailure(
  project: string,
  declaration: DurableObjectDeclaration,
  failureMode: 'probe' | 'native' | 'early' = 'probe',
): Promise<void> {
  const native = failureMode === 'native';
  const early = failureMode === 'early';
  const directory = early ? path.join(project, 'blocked-runtime') : project;
  if (early) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, declaration.module),
      await readFile(path.join(project, declaration.module)),
    );
    await writeFile(path.join(directory, '.upwind'), 'not a storage directory');
  }
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restore the method; calls supply its runtime receiver.
  const originalD1 = Miniflare.prototype.getD1Database;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restore the method; calls supply its runtime receiver.
  const originalDispose = Miniflare.prototype.dispose;
  const cleanup = Promise.withResolvers<undefined>();
  const warnings: string[] = [];
  const warn = console.warn;
  let reads = 0;
  let hasRuntime = false;
  const runtimeCreated = (): boolean => hasRuntime;
  let resources: LocalResources | undefined;
  const failure = Object.assign(new Error('fixture-probe-failure'), {
    code: native ? 'ERR_RUNTIME_FAILURE' : 'SQLITE_BUSY',
  });
  Miniflare.prototype.getD1Database = async function getD1Database(
    this: Miniflare,
    ...args: Parameters<Miniflare['getD1Database']>
  ) {
    hasRuntime = true;
    const database = await originalD1.apply(this, args);
    reads += 1;
    if (reads !== 1) return database;
    return new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'prepare')
          return () => {
            throw failure;
          };
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  };
  Miniflare.prototype.dispose = async function dispose(this: Miniflare) {
    try {
      await originalDispose.call(this);
    } finally {
      cleanup.resolve(undefined);
    }
  };
  console.warn = (message: unknown) => {
    warnings.push(String(message));
  };
  try {
    process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([declaration]);
    resources = await startLocalResources(directory, { answersSignals: true });
    assert.equal(durableObject(declaration.name), undefined);
    if (native) {
      assert.equal(reads, 2);
      assert.ok(d1('UPWIND_D1'));
      assert.ok(warnings.some((message) => message.includes('without Durable Object namespaces')));
    } else {
      assert.equal(reads, early ? 0 : 1);
      assert.equal(d1('UPWIND_D1'), undefined);
      assert.ok(
        warnings.some((message) => message.includes(early ? 'could not start' : failure.message)),
      );
      assert.ok(warnings.every((message) => !message.includes('retrying')));
    }
  } finally {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await resources?.dispose();
          if (runtimeCreated()) await cleanup.promise;
        })(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            reject(new Error('local probe fixture cleanup did not finish'));
          }, CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      Miniflare.prototype.getD1Database = originalD1;
      Miniflare.prototype.dispose = originalDispose;
      console.warn = warn;
    }
  }
}
