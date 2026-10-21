import { prefetchAuditKey } from '@stayingupwind/host/prefetch-audit';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import prefetch, { PrefetchForDeployment } from '../src/prefetch/worker.ts';

const OWN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const SERVICE = 'audit-prefetch';
const BODY = 'the deployment stored bytes';

function identity() {
  return { nonce: crypto.randomUUID(), deploymentId: 'deployment', scriptName: 'app' };
}

function asking(method = 'GET'): Request {
  return new Request(`https://prefetch.test/v1/blobs/${OWN}`, { method });
}

function entry(props: unknown, service?: string) {
  // Supply immutable binding props to the actual class while retaining real waitUntil state.
  const ctx = Object.assign(createExecutionContext(), { props });
  const worker = new PrefetchForDeployment(ctx, {
    ARTIFACTS: env.ARTIFACTS,
    ...(service !== undefined && { PREFETCH_MIGRATION_AUDIT_SERVICE: service }),
  });
  return { ctx, worker };
}

describe('a prefetch binding witness during an explicit migration window', () => {
  beforeEach(async () => {
    await env.ARTIFACTS.put(blobObjectKey(OWN), BODY);
    await env.ARTIFACTS.put(blobObjectKey(OTHER), BODY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves ordinary delivery free of witness writes and background work', async () => {
    const audit = identity();
    const { worker, ctx } = entry({ allowedSha256: { [OWN]: true }, migrationAudit: audit });
    const put = vi.spyOn(env.ARTIFACTS, 'put');
    const waitUntil = vi.spyOn(ctx, 'waitUntil');

    const response = await worker.fetch(asking());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toBe(BODY);
    expect(put).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'])(
    'records callee props instead of request claims on %s',
    async (method) => {
      const audit = identity();
      const { worker, ctx } = entry(
        { allowedSha256: { [OWN]: true }, migrationAudit: audit },
        SERVICE,
      );
      const get = vi.spyOn(env.ARTIFACTS, 'get');
      const head = vi.spyOn(env.ARTIFACTS, 'head');
      const request = new Request(`https://prefetch.test/v1/blobs/${OTHER}?nonce=forged`, {
        method,
        headers: {
          'x-audit-nonce': 'forged',
          'x-deployment-id': 'foreign',
          'x-allowed-sha256': OTHER,
        },
      });

      const response = await worker.fetch(request);
      await response.text();
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
      expect(get).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();

      const stored = await env.ARTIFACTS.get(prefetchAuditKey(audit.nonce));

      await expect(stored?.json<unknown>()).resolves.toStrictEqual({
        version: 1,
        ...audit,
        service: SERVICE,
        entrypoint: 'PrefetchForDeployment',
        allowedSha256: { [OWN]: true },
      });
    },
  );

  it('retries a failed witness write and remembers only a settled success', async () => {
    const audit = identity();
    const props = { allowedSha256: { [OWN]: true }, migrationAudit: audit };
    const put = vi.spyOn(env.ARTIFACTS, 'put');
    put.mockRejectedValueOnce(new Error('temporary evidence failure'));
    const first = entry(props, SERVICE);

    const response = await first.worker.fetch(asking());
    await response.text();
    await waitOnExecutionContext(first.ctx);

    expect(response.status).toBe(200);
    await expect(env.ARTIFACTS.get(prefetchAuditKey(audit.nonce))).resolves.toBeNull();

    const second = entry(props, SERVICE);
    const retried = await second.worker.fetch(asking());
    await retried.text();
    await waitOnExecutionContext(second.ctx);
    const third = entry(props, SERVICE);
    const repeated = await third.worker.fetch(asking());
    await repeated.text();
    await waitOnExecutionContext(third.ctx);

    expect(put).toHaveBeenCalledTimes(2);
    await expect(env.ARTIFACTS.head(prefetchAuditKey(audit.nonce))).resolves.not.toBeNull();

    expect([retried.status, repeated.status]).toStrictEqual([200, 200]);
  });

  it('does not invent audit metadata for a successful authorized read', async () => {
    const { worker, ctx } = entry({ allowedSha256: { [OWN]: true } }, SERVICE);
    const put = vi.spyOn(env.ARTIFACTS, 'put');

    const response = await worker.fetch(asking());
    const body = await response.text();
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(body).toBe(BODY);
    expect(put).not.toHaveBeenCalled();
  });

  it('coalesces concurrent witnesses without delaying any blob response', async () => {
    const audit = identity();
    const props = { allowedSha256: { [OWN]: true }, migrationAudit: audit };
    const release = Promise.withResolvers<true>();
    const originalPut = env.ARTIFACTS.put.bind(env.ARTIFACTS);
    const put = vi.spyOn(env.ARTIFACTS, 'put').mockImplementation(async (...args) => {
      await release.promise;
      return originalPut(...args);
    });
    const requests = Array.from({ length: 6 }, () => entry(props, SERVICE));

    try {
      const delivered = await Promise.all(
        requests.map(async ({ worker }) => {
          const response = await worker.fetch(asking());
          return { status: response.status, body: await response.text() };
        }),
      );

      expect(delivered).toStrictEqual(
        Array.from({ length: 6 }, () => ({ status: 200, body: BODY })),
      );
      expect(put).toHaveBeenCalledTimes(1);
      await expect(env.ARTIFACTS.get(prefetchAuditKey(audit.nonce))).resolves.toBeNull();
    } finally {
      release.resolve(true);
      await Promise.all(requests.map(({ ctx }) => waitOnExecutionContext(ctx)));
    }

    await expect(env.ARTIFACTS.head(prefetchAuditKey(audit.nonce))).resolves.not.toBeNull();
  });

  it('remembers completed witnesses for alternating deployment bindings', async () => {
    const audits = [identity(), identity()];
    const put = vi.spyOn(env.ARTIFACTS, 'put');

    for (let round = 0; round < 3; round += 1) {
      for (const audit of audits) {
        const { worker, ctx } = entry(
          { allowedSha256: { [OWN]: true }, migrationAudit: audit },
          SERVICE,
        );
        const response = await worker.fetch(asking());

        await expect(response.text()).resolves.toBe(BODY);

        await waitOnExecutionContext(ctx);
      }
    }

    expect(put).toHaveBeenCalledTimes(2);

    for (const audit of audits) {
      await expect(env.ARTIFACTS.head(prefetchAuditKey(audit.nonce))).resolves.not.toBeNull();
    }
  });

  it('coalesces pending witnesses independently for alternating deployment bindings', async () => {
    const audits = [identity(), identity()];
    const release = Promise.withResolvers<true>();
    const originalPut = env.ARTIFACTS.put.bind(env.ARTIFACTS);
    const put = vi.spyOn(env.ARTIFACTS, 'put').mockImplementation(async (...args) => {
      await release.promise;
      return originalPut(...args);
    });
    const requests = [...audits, ...audits, ...audits].map((audit) =>
      entry({ allowedSha256: { [OWN]: true }, migrationAudit: audit }, SERVICE),
    );
    try {
      const bodies = await Promise.all(
        requests.map(async ({ worker }) => (await worker.fetch(asking())).text()),
      );

      expect(bodies).toStrictEqual(requests.map(() => BODY));
      expect(put).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve(true);
      await Promise.all(requests.map(({ ctx }) => waitOnExecutionContext(ctx)));
    }
  });

  it('retries expired work without letting an older failure clear the new marker', async () => {
    const audit = identity();
    const props = { allowedSha256: { [OWN]: true }, migrationAudit: audit };
    const firstWrite = Promise.withResolvers<true>();
    const secondWrite = Promise.withResolvers<true>();
    const originalPut = env.ARTIFACTS.put.bind(env.ARTIFACTS);
    const put = vi.spyOn(env.ARTIFACTS, 'put');
    put.mockImplementationOnce(async (...args) => {
      await firstWrite.promise;
      return originalPut(...args);
    });
    put.mockImplementationOnce(async (...args) => {
      await secondWrite.promise;
      return originalPut(...args);
    });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const first = entry(props, SERVICE);
    const second = entry(props, SERVICE);
    const third = entry(props, SERVICE);

    try {
      const original = await first.worker.fetch(asking());

      await expect(original.text()).resolves.toBe(BODY);
      expect(put).toHaveBeenCalledTimes(1);

      now += 60_000;
      const retried = await second.worker.fetch(asking());

      await expect(retried.text()).resolves.toBe(BODY);
      expect(put).toHaveBeenCalledTimes(2);

      firstWrite.reject(new Error('the expired write eventually failed'));
      await waitOnExecutionContext(first.ctx);

      const concurrent = await third.worker.fetch(asking());

      await expect(concurrent.text()).resolves.toBe(BODY);
      expect(put).toHaveBeenCalledTimes(2);
      expect([original.status, retried.status, concurrent.status]).toStrictEqual([200, 200, 200]);
    } finally {
      firstWrite.resolve(true);
      secondWrite.resolve(true);
      await Promise.all([first, second, third].map(({ ctx }) => waitOnExecutionContext(ctx)));
    }

    await expect(env.ARTIFACTS.head(prefetchAuditKey(audit.nonce))).resolves.not.toBeNull();
  });

  it('delivers the blob before an independent witness write settles', async () => {
    const audit = identity();
    const release = Promise.withResolvers<true>();
    const put = env.ARTIFACTS.put.bind(env.ARTIFACTS);
    vi.spyOn(env.ARTIFACTS, 'put').mockImplementationOnce(async (...args) => {
      await release.promise;
      return put(...args);
    });
    const { worker, ctx } = entry(
      { allowedSha256: { [OWN]: true }, migrationAudit: audit },
      SERVICE,
    );
    try {
      const response = await worker.fetch(asking());
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toBe(BODY);
      await expect(env.ARTIFACTS.get(prefetchAuditKey(audit.nonce))).resolves.toBeNull();

      release.resolve(true);
      await waitOnExecutionContext(ctx);

      await expect(env.ARTIFACTS.head(prefetchAuditKey(audit.nonce))).resolves.not.toBeNull();
    } finally {
      release.resolve(true);
      await waitOnExecutionContext(ctx);
    }
  });

  it('writes no evidence for a nonce outside the private witness key grammar', async () => {
    const { worker, ctx } = entry(
      {
        allowedSha256: { [OWN]: true },
        migrationAudit: {
          nonce: '../blobs/foreign',
          deploymentId: 'deployment',
          scriptName: 'app',
        },
      },
      SERVICE,
    );
    const put = vi.spyOn(env.ARTIFACTS, 'put');

    const response = await worker.fetch(asking());
    await response.text();
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(put).not.toHaveBeenCalled();
  });

  it('does not manufacture strict evidence from a write method or the legacy entrypoint', async () => {
    const audit = identity();
    const { worker, ctx } = entry(
      { allowedSha256: { [OWN]: true }, migrationAudit: audit },
      SERVICE,
    );
    const put = vi.spyOn(env.ARTIFACTS, 'put');

    const written = await worker.fetch(asking('PUT'));
    await written.text();
    await waitOnExecutionContext(ctx);
    const legacy = await prefetch.fetch(asking(), {
      ARTIFACTS: env.ARTIFACTS,
      PREFETCH_MIGRATION_AUDIT_SERVICE: SERVICE,
    });
    await legacy.text();

    expect(written.status).toBe(405);
    expect(legacy.status).toBe(200);
    expect(put).not.toHaveBeenCalled();
  });
});
