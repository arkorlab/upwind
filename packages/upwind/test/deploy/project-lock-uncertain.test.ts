import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentClient } from '../../src/deploy/agent-client.ts';
import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import { projectNames } from '../../src/deploy/names.ts';
import {
  projectLockBucket,
  ProjectWriteUncertainError,
  withProjectLock,
} from '../../src/deploy/project-lock.ts';
import { AGENT_PATHS } from '../../src/deploy/workers/protocol.ts';
import { fakeCloudflare } from './fake-cloudflare.ts';

const NAMES = projectNames('shop');
const BUCKET = projectLockBucket(NAMES);
const WRITE = '/accounts/account-1/workers/scripts/shop-agent/secrets';
const AGENT_URL = new URL('https://shop-agent.example.workers.dev/');

function scope(send: typeof fetch, sleep = vi.fn(async () => undefined)) {
  return {
    client: createCloudflareClient({ apiToken: 'token', fetch: send, sleep }),
    accountId: 'account-1',
  };
}

function envelope(status: number): Response {
  return Response.json(
    { success: false, errors: [{ code: status, message: `refused with ${status}` }] },
    { status },
  );
}

function deletes(fake: ReturnType<typeof fakeCloudflare>) {
  return fake.requests.filter((request) => request.method === 'DELETE');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('uncertain writes keep project exclusion', () => {
  it.each(['network', 'server', 'malformed'] as const)(
    'does not retry a REST write with a %s outcome, or release its lock',
    async (outcome) => {
      const fake = fakeCloudflare();
      const sleep = vi.fn(async () => undefined);
      let attempts = 0;
      const send: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === WRITE) {
          attempts += 1;
          if (outcome === 'network') {
            throw new TypeError('the write answer was lost');
          }
          return outcome === 'server' ? envelope(503) : new Response('not JSON');
        }
        return fake.fetch(request);
      };
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(
        withProjectLock(scope(send, sleep), NAMES, ({ scope: locked }) => {
          return locked.client.request('PUT', WRITE, {
            body: { name: 'AGENT_KEY', text: 'key' },
            // The guarded client must override a caller that would otherwise retry this write.
            repeatable: true,
          });
        }),
      ).rejects.toThrow();
      expect(attempts).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(fake.buckets.has(BUCKET)).toBe(true);
      expect(deletes(fake)).toStrictEqual([]);
      expect(warning).toHaveBeenCalled();
    },
  );

  it.each(['network', 'server'] as const)(
    'also quarantines a raw object PUT with a %s outcome',
    async (outcome) => {
      const fake = fakeCloudflare();
      const sleep = vi.fn(async () => undefined);
      let attempts = 0;
      const send: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === WRITE) {
          attempts += 1;
          if (outcome === 'network') {
            throw new TypeError('the object answer was lost');
          }
          return envelope(503);
        }
        return fake.fetch(request);
      };
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(
        withProjectLock(scope(send, sleep), NAMES, ({ scope: locked }) => {
          return locked.client.raw('PUT', WRITE, { body: 'object bytes', repeatable: true });
        }),
      ).rejects.toThrow();
      expect(attempts).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(fake.buckets.has(BUCKET)).toBe(true);
      expect(deletes(fake)).toStrictEqual([]);
    },
  );

  it('retains the lock and refuses later writes when cleanup swallows an uncertain write', async () => {
    const fake = fakeCloudflare();
    let attempts = 0;
    const send: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === WRITE) {
        attempts += 1;
        return envelope(503);
      }
      return fake.fetch(request);
    };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      withProjectLock(scope(send), NAMES, async ({ scope: locked }) => {
        // Agent-session cleanup warns and returns success after a failed secret rotation.
        try {
          await locked.client.request('PUT', WRITE, { body: { name: 'AGENT_KEY', text: 'key' } });
        } catch {
          // The lock must remember this even though its caller handled the error.
        }
        await expect(
          locked.client.request('PUT', WRITE, { body: { name: 'AGENT_KEY', text: 'another' } }),
        ).rejects.toBeInstanceOf(ProjectWriteUncertainError);
        return 'the deployment is live';
      }),
    ).resolves.toBe('the deployment is live');
    expect(attempts).toBe(1);
    expect(fake.buckets.has(BUCKET)).toBe(true);
    expect(deletes(fake)).toStrictEqual([]);
    expect(warning).toHaveBeenCalled();
  });

  it.each([400, 409, 429])(
    'releases after a REST write is explicitly refused with %i',
    async (status) => {
      const fake = fakeCloudflare();
      const sleep = vi.fn(async () => undefined);
      let attempts = 0;
      const send: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === WRITE) {
          attempts += 1;
          return envelope(status);
        }
        return fake.fetch(request);
      };
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(
        withProjectLock(scope(send, sleep), NAMES, ({ scope: locked }) => {
          return locked.client.request('PUT', WRITE, { body: {}, repeatable: true });
        }),
      ).rejects.toThrow();
      expect(attempts).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(fake.buckets.has(BUCKET)).toBe(false);
      expect(deletes(fake)).toHaveLength(1);
      expect(warning).not.toHaveBeenCalled();
    },
  );

  it('releases after a read fails without making a write uncertain', async () => {
    const fake = fakeCloudflare();
    const sleep = vi.fn(async () => undefined);
    const send: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      return new URL(request.url).pathname === WRITE ? envelope(503) : fake.fetch(request);
    };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      withProjectLock(scope(send, sleep), NAMES, ({ scope: locked }) => {
        return locked.client.request('GET', WRITE);
      }),
    ).rejects.toThrow();
    expect(fake.buckets.has(BUCKET)).toBe(false);
    expect(deletes(fake)).toHaveLength(1);
    expect(warning).not.toHaveBeenCalled();
  });

  it.each(['network', 'server'] as const)(
    'stops an agent write after its first %s failure and retains the lock',
    async (outcome) => {
      const fake = fakeCloudflare();
      let attempts = 0;
      const send: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).host === AGENT_URL.host) {
          attempts += 1;
          if (outcome === 'network') {
            throw new TypeError('the agent answer was lost');
          }
          return new Response('the provider could not finish', { status: 503 });
        }
        return fake.fetch(request);
      };
      const sleep = vi.fn(async () => undefined);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(
        withProjectLock(
          scope(send),
          NAMES,
          ({ fetch: lockedFetch }) => {
            const agent = agentClient({ url: AGENT_URL, key: 'key', fetch: lockedFetch, sleep });
            return agent.call('PUT', `${AGENT_PATHS.blob}blobs/example`, { body: 'bytes' });
          },
          { fetch: send },
        ),
      ).rejects.toBeInstanceOf(ProjectWriteUncertainError);
      expect(attempts).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(fake.buckets.has(BUCKET)).toBe(true);
      expect(deletes(fake)).toStrictEqual([]);
      expect(warning).toHaveBeenCalled();
    },
  );

  it('keeps the missing-blobs POST read-only, including its normal retries and failed result', async () => {
    const fake = fakeCloudflare();
    let attempts = 0;
    const send: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).host === AGENT_URL.host) {
        expect(request.method).toBe('POST');
        expect(new URL(request.url).pathname).toBe(AGENT_PATHS.missing);
        attempts += 1;
        return new Response('the read failed', { status: 503 });
      }
      return fake.fetch(request);
    };
    const sleep = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      withProjectLock(
        scope(send),
        NAMES,
        ({ fetch: lockedFetch }) => {
          const agent = agentClient({ url: AGENT_URL, key: 'key', fetch: lockedFetch, sleep });
          return agent.call('POST', AGENT_PATHS.missing, { body: JSON.stringify({ keys: [] }) });
        },
        { fetch: send },
      ),
    ).rejects.toThrow(/the deploy agent answered 503/u);
    expect(attempts).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(fake.buckets.has(BUCKET)).toBe(false);
    expect(deletes(fake)).toHaveLength(1);
    expect(warning).not.toHaveBeenCalled();
  });
});
