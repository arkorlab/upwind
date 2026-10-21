import { describe, expect, it } from 'vitest';

import {
  CloudflareApiError,
  createCloudflareClient,
  listPages,
  unlessMissing,
} from '../../src/deploy/cloudflare/client.ts';
import { fakeCloudflare } from './fake-cloudflare.ts';

function clientOf(fake: ReturnType<typeof fakeCloudflare>, waits: number[] = []) {
  return createCloudflareClient({
    apiToken: 'token',
    fetch: fake.fetch,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  });
}

describe('the Cloudflare client', () => {
  it('reads the result out of the envelope', async () => {
    const fake = fakeCloudflare();
    const answer = await clientOf(fake).request<{ subdomain: string }>(
      'GET',
      '/accounts/account-1/workers/subdomain',
    );

    expect(answer.result).toStrictEqual({ subdomain: 'example' });
  });

  it('keeps what Cloudflare said when it refuses', async () => {
    const fake = fakeCloudflare();
    const refused = clientOf(fake).request('GET', '/accounts/account-1/r2/buckets/missing');

    await expect(refused).rejects.toBeInstanceOf(CloudflareApiError);
    await expect(refused).rejects.toMatchObject({ status: 404, codes: [10_007], notFound: true });
    await expect(refused).rejects.toThrow(/bucket not found \(10007\)/u);
  });

  it('asks again after the wait a 429 names', async () => {
    const fake = fakeCloudflare();
    fake.fail({ path: /\/workers\/subdomain$/u }, 429, { headers: { 'retry-after': '3' } });
    const waits: number[] = [];
    const answer = await clientOf(fake, waits).request(
      'GET',
      '/accounts/account-1/workers/subdomain',
    );

    expect(answer.result).toStrictEqual({ subdomain: 'example' });
    expect(waits).toStrictEqual([3000]);
    expect(fake.requests.filter((request) => request.path.endsWith('/subdomain'))).toHaveLength(2);
  });

  it('asks again after a 5xx, waiting longer each time, and gives up after five', async () => {
    const fake = fakeCloudflare();
    fake.fail({ path: /\/workers\/subdomain$/u }, 503, { times: 10 });
    const waits: number[] = [];

    await expect(
      clientOf(fake, waits).request('GET', '/accounts/account-1/workers/subdomain'),
    ).rejects.toMatchObject({ status: 503 });
    expect(waits).toStrictEqual([1000, 2000, 4000, 8000]);
  });

  it('never makes a request that creates twice, unless told it may', async () => {
    const fake = fakeCloudflare();
    fake.fail({ method: 'POST', path: /\/r2\/buckets$/u }, 503);

    await expect(
      clientOf(fake).request('POST', '/accounts/account-1/r2/buckets', { body: { name: 'b' } }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fake.buckets.has('b')).toBe(false);

    fake.fail({ method: 'POST', path: /\/r2\/buckets$/u }, 503);
    await clientOf(fake).request('POST', '/accounts/account-1/r2/buckets', {
      body: { name: 'b' },
      repeatable: true,
    });

    expect(fake.buckets.has('b')).toBe(true);
  });

  it('lists every page', async () => {
    const fake = fakeCloudflare();
    for (let index = 0; index < 5; index += 1) {
      fake.kv.set(`kv-${index}`, { id: `kv-${index}`, title: `t${index}` });
    }
    const listed = await listPages(clientOf(fake), '/accounts/account-1/storage/kv/namespaces', {
      perPage: 2,
    });

    expect(listed).toHaveLength(5);
  });

  it('reads a missing thing as nothing, and anything else as the failure it is', async () => {
    const fake = fakeCloudflare();
    const client = clientOf(fake);

    await expect(
      unlessMissing(client.request('GET', '/accounts/account-1/r2/buckets/missing')),
    ).resolves.toBeUndefined();
    await expect(
      unlessMissing(client.request('GET', '/accounts/another/r2/buckets/missing')),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('answers a missing object as nothing, and an object as its bytes', async () => {
    const fake = fakeCloudflare();
    fake.buckets.set(
      'b',
      new Map([['a/b.txt', { bytes: new TextEncoder().encode('hi'), contentType: 'text/plain' }]]),
    );
    const client = clientOf(fake);

    await expect(
      client.raw('GET', '/accounts/account-1/r2/buckets/b/objects/missing'),
    ).resolves.toBeUndefined();

    const found = await client.raw('GET', '/accounts/account-1/r2/buckets/b/objects/a/b.txt');

    await expect(found?.text()).resolves.toBe('hi');
  });
});
