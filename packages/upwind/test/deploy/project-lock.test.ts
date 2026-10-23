import nodePath from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { blobObjectKey } from '@stayingupwind/host/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import { projectNames } from '../../src/deploy/names.ts';
import { BUNDLE_PATH } from '../../src/deploy/preflight.ts';
import { projectLockBucket, withProjectLock } from '../../src/deploy/project-lock.ts';
import { storageName } from '../../src/deploy/stores.ts';
import { uploadBuildBlobs } from '../../src/deploy/target.ts';
import { AGENT_PATHS } from '../../src/deploy/workers/protocol.ts';
import { bundleOf, deployableFunction, moduleOf, projectDir } from './bundle.ts';
import { fakeCloudflare } from './fake-cloudflare.ts';

const NAMES = projectNames('shop');
const BUCKET = projectLockBucket(NAMES);
const BUCKETS = '/accounts/account-1/r2/buckets';
const LOCK = `${BUCKETS}/${BUCKET}`;

function scope(send: typeof fetch, sleep = vi.fn(() => Promise.resolve())) {
  return {
    client: createCloudflareClient({ apiToken: 'token', fetch: send, sleep }),
    accountId: 'account-1',
  };
}

function signal() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: resolve };
}

describe('project exclusion through the R2 management API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fits every accepted project name and cannot name any derived project or app store', () => {
    const bindings = ['', 'UPWIND_R2', '--_---', 'DEPLOY___LOCK', 'A_'.repeat(100)];
    for (let length = 2; length <= 24; length += 1) {
      const names = projectNames(`a${'b'.repeat(length - 2)}z`);
      const lock = projectLockBucket(names);

      expect(lock).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u);
      expect(lock).toHaveLength(length + 21);
      expect(lock).toContain('--');

      for (const name of Object.values(names)) {
        expect(name).not.toContain('--');
      }
      for (const name of bindings) {
        for (const kind of ['r2', 'd1'] as const) {
          expect(storageName(names.project, { kind, name })).not.toContain('--');
        }
      }
    }

    const longest = projectNames('a'.repeat(24));

    expect(projectLockBucket(longest)).toHaveLength(45);
    expect(() => projectNames('a'.repeat(25))).toThrow(/not a project name/u);
    expect(() => projectNames('a--z')).toThrow(/not a project name/u);
  });

  it.each([400, 409])(
    'leaves an existing nonempty bucket untouched on a %i refusal',
    async (status) => {
      const fake = fakeCloudflare();
      const objects = new Map([
        ['existing', { bytes: new Uint8Array([1]), contentType: 'application/octet-stream' }],
      ]);
      fake.buckets.set(BUCKET, objects);
      fake.fail({ method: 'POST', path: BUCKETS }, status);
      const run = vi.fn(() => Promise.resolve('done'));

      await expect(withProjectLock(scope(fake.fetch), NAMES, run)).rejects.toThrow(
        /could not acquire the project lock/u,
      );
      expect(fake.buckets.get(BUCKET)).toBe(objects);
      expect(objects.size).toBe(1);
      expect(fake.requests.map((request) => request.method)).toStrictEqual(['POST']);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('refuses an independent client while a command is held, then lets it acquire', async () => {
    const fake = fakeCloudflare();
    const entered = signal();
    const finish = signal();
    const first = withProjectLock(scope(fake.fetch), NAMES, async () => {
      entered.open();
      await finish.promise;
      return 'first';
    });
    await entered.promise;
    const second = vi.fn(() => Promise.resolve('second'));
    try {
      await expect(withProjectLock(scope(fake.fetch), NAMES, second)).rejects.toThrow(
        /could not acquire the project lock/u,
      );
      expect(second).not.toHaveBeenCalled();
      expect(fake.buckets.has(BUCKET)).toBe(true);
      expect(fake.requests.filter((request) => request.method === 'DELETE')).toStrictEqual([]);
    } finally {
      finish.open();

      await expect(first).resolves.toBe('first');
    }

    await expect(withProjectLock(scope(fake.fetch), NAMES, second)).resolves.toBe('second');
    expect(second).toHaveBeenCalledExactlyOnceWith(expect.anything());
    expect(fake.buckets.has(BUCKET)).toBe(false);
  });

  it.each([429, 503])('does not retry or release a create refused with %i', async (status) => {
    const fake = fakeCloudflare();
    fake.fail({ method: 'POST', path: BUCKETS }, status);
    const sleep = vi.fn(() => Promise.resolve());
    const run = vi.fn(() => Promise.resolve('done'));

    await expect(withProjectLock(scope(fake.fetch, sleep), NAMES, run)).rejects.toThrow(
      /could not acquire the project lock/u,
    );
    expect(
      fake.requests.map(({ method, path: pathname }) => ({ method, path: pathname })),
    ).toStrictEqual([{ method: 'POST', path: BUCKETS }]);
    expect(run).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(['lost', 'malformed'])(
    'leaves a committed create with a %s answer for manual recovery',
    async (answer) => {
      const fake = fakeCloudflare();
      const send: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const response = await fake.fetch(request);
        if (request.method === 'POST' && new URL(request.url).pathname.endsWith(BUCKETS)) {
          await response.body?.cancel();
          if (answer === 'malformed') {
            return new Response('not JSON');
          }
          throw new TypeError('the create answer was lost');
        }
        return response;
      };
      const sleep = vi.fn(() => Promise.resolve());
      const run = vi.fn(() => Promise.resolve('done'));

      await expect(withProjectLock(scope(send, sleep), NAMES, run)).rejects.toThrow(
        /confirming every deploy, rollback and destroy/u,
      );
      expect(fake.buckets.has(BUCKET)).toBe(true);
      expect(fake.requests.map((request) => request.method)).toStrictEqual(['POST']);
      expect(run).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it('does not repeat a lost delete and remove a later owner', async () => {
    const fake = fakeCloudflare();
    const next = scope(fake.fetch);
    const send: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await fake.fetch(request);
      if (request.method === 'DELETE' && new URL(request.url).pathname.endsWith(LOCK)) {
        await response.body?.cancel();
        // The first delete committed, and another host acquired before its answer was lost.
        await next.client.request('POST', BUCKETS, { body: { name: BUCKET }, repeatable: false });
        throw new TypeError('the delete answer was lost');
      }
      return response;
    };
    const sleep = vi.fn(() => Promise.resolve());
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {
      // The warning is asserted below.
    });

    await expect(
      withProjectLock(scope(send, sleep), NAMES, () => Promise.resolve('live')),
    ).resolves.toBe('live');
    expect(fake.buckets.has(BUCKET)).toBe(true);
    expect(fake.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not release'));
  });

  it('keeps the primary error when releasing is refused', async () => {
    const fake = fakeCloudflare();
    fake.fail({ method: 'DELETE', path: LOCK }, 503);
    const sleep = vi.fn(() => Promise.resolve());
    const error = new Error('staging failed');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {
      // The warning is asserted below.
    });

    await expect(
      withProjectLock(scope(fake.fetch, sleep), NAMES, () => Promise.reject(error)),
    ).rejects.toBe(error);
    expect(fake.buckets.has(BUCKET)).toBe(true);
    expect(fake.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('could not release'));
  });

  it('holds the lock until sibling blob PUTs settle after a failure, without starting queued PUTs', async () => {
    const fake = fakeCloudflare();
    const dir = projectDir();
    const files = Array.from({ length: 10 }, (_, index) => {
      const module = moduleOf(dir, `file-${index}.txt`, 'text', `file ${index}`);
      return { pathname: `/${module.name}`, blob: module.blob, immutable: false };
    });
    const bundle = bundleOf(deployableFunction(dir), { staticFiles: files });
    const started = signal();
    const fail = signal();
    const finish = signal();
    const error = new Error('a blob PUT failed');
    let uploads = 0;
    let settled = false;
    const agent = {
      url: new URL('https://agent.example/'),
      call: async (method: string, route: string): Promise<Response> => {
        if (method === 'POST' && route === AGENT_PATHS.missing) {
          return Response.json({ missing: files.map((file) => blobObjectKey(file.blob.sha256)) });
        }
        uploads += 1;
        const first = uploads === 1;
        if (uploads === 8) {
          started.open();
        }
        if (first) {
          await fail.promise;
          throw error;
        }
        await finish.promise;
        return new Response(null, { status: 204 });
      },
    };
    const outcome = (async () => {
      try {
        return await withProjectLock(scope(fake.fetch), NAMES, () =>
          uploadBuildBlobs(agent, nodePath.dirname(nodePath.join(dir, BUNDLE_PATH)), bundle),
        );
      } catch (error_) {
        return error_;
      } finally {
        settled = true;
      }
    })();
    await started.promise;
    fail.open();
    // Let the rejection propagate, while the seven sibling PUTs remain held by the fake API.
    await setImmediate();
    try {
      expect(settled).toBe(false);
      expect(fake.buckets.has(BUCKET)).toBe(true);
      expect(fake.requests.filter((request) => request.method === 'DELETE')).toStrictEqual([]);
    } finally {
      finish.open();
    }

    await expect(outcome).resolves.toBe(error);
    expect(uploads).toBe(8);
    expect(fake.buckets.has(BUCKET)).toBe(false);
    expect(fake.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
  });
});
