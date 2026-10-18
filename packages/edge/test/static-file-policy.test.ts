import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import type { EdgeRuntime } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { PolicyLookup } from '../src/preview/manifest.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const FILE_PATH = '/download.txt';
const FILE_BODY = 'the shipped file';
const POLICY_ID = 'slow-named-policy';
const HIGH_SURROGATE_UNIT = 0xd800;
const LONE_HIGH_SURROGATE = String.fromCodePoint(HIGH_SURROGATE_UNIT);

/** A policy still out while the manifest is already present. */
async function delayedPolicyFile(
  options: {
    readonly method?: string;
    readonly privateDelivery?: boolean;
    readonly policyId?: string;
    readonly match?: string;
    readonly ruleHeaders?: Readonly<Record<string, string>>;
    readonly dispatchApp?: EdgeRuntime['dispatchApp'];
  } = {},
) {
  const site = await seedSite({
    document: pprDocument(),
    files: { [FILE_PATH]: FILE_BODY },
    headerRules: [
      {
        sourceRegex: String.raw`^/download\.txt$`,
        headers: { 'x-file-rule': 'kept', ...options.ruleHeaders },
      },
    ],
  });
  const app = {
    deploymentId: 'dpl_site',
    scriptName: 'site-app',
    ...(options.match !== undefined && { middlewareScriptName: 'site-middleware' }),
  };
  const manifest: ProjectManifest = {
    ...site.manifest,
    ...(options.match !== undefined && {
      middleware: { matchers: [{ sourceRegex: options.match }] },
    }),
  };
  const policy = Promise.withResolvers<PolicyLookup>();
  const ctx = createExecutionContext();
  const request = navigation(FILE_PATH, { method: options.method ?? 'GET' });
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    ...(options.dispatchApp !== undefined && { dispatchApp: options.dispatchApp }),
  });
  const response = serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime,
      host: standaloneHost(env),
      pointer: { ...site.pointer, app, policyId: options.policyId ?? POLICY_ID },
      pointerMs: 0,
      privateDelivery: options.privateDelivery ?? false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
      policyLookup: policy.promise,
    },
  );
  return { response, policy, ctx };
}

describe('a shipped file with a policy read still out', () => {
  it.each([
    { policyId: 'ordinary-policy', encoded: 'ordinary-policy' },
    { policyId: '日本\r\n', encoded: '%E6%97%A5%E6%9C%AC%5Cr%5Cn' },
    { policyId: `semi;percent%${LONE_HIGH_SURROGATE}`, encoded: 'semi%3Bpercent%25%5Cud800' },
  ])('encodes the unresolved policy field $encoded before streaming', async (example) => {
    const pending = await delayedPolicyFile({ policyId: example.policyId });
    try {
      const response = await pending.response;

      expect(response.status).toBe(200);
      expect(response.headers.get(EDGE_DEBUG_HEADER)).toContain(`policy=${example.encoded};`);
      await expect(response.text()).resolves.toBe(FILE_BODY);
    } finally {
      pending.policy.resolve({ kind: 'unavailable' });
      await waitOnExecutionContext(pending.ctx);
    }
  });

  it('answers HEAD from the manifest before policy arrives, retaining headers and private delivery', async () => {
    const pending = await delayedPolicyFile({ method: 'HEAD', privateDelivery: true });
    try {
      const response = await pending.response;

      expect(response.status).toBe(200);
      expect(response.headers.get('x-file-rule')).toBe('kept');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-arkor-edge')).toContain(`policy=${POLICY_ID};`);
      await expect(response.text()).resolves.toBe('');
    } finally {
      pending.policy.resolve({ kind: 'unavailable' });
      await waitOnExecutionContext(pending.ctx);
    }
  });

  it('streams a file before policy arrives when the middleware matcher excludes it', async () => {
    const dispatchApp = vi.fn(() => Promise.resolve(new Response('must not dispatch')));
    const pending = await delayedPolicyFile({ match: '^/protected/', dispatchApp });
    try {
      const response = await pending.response;

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe(FILE_BODY);
      expect(response.headers.get('x-file-rule')).toBe('kept');
      expect(dispatchApp).not.toHaveBeenCalled();
    } finally {
      pending.policy.resolve({ kind: 'unavailable' });
      await waitOnExecutionContext(pending.ctx);
    }
  });

  it('waits for the selected middleware budget when the matcher covers the file', async () => {
    const dispatchApp = vi.fn(() =>
      Promise.resolve(new Response(null, { headers: { 'x-middleware-next': '1' } })),
    );
    const pending = await delayedPolicyFile({ match: String.raw`^/download\.txt$`, dispatchApp });
    const policy = {
      ...DEFAULT_DELIVERY_POLICY,
      id: POLICY_ID,
      middleware: { cpuMs: 17, subRequests: 9, timeoutMs: 5000 },
    };
    // Let every runnable continuation of the resolved manifest run; the policy stays deferred.
    await scheduler.wait(0);

    expect(dispatchApp).not.toHaveBeenCalled();

    pending.policy.resolve({ kind: 'found', source: 'exact', policy });

    const response = await pending.response;

    await expect(response.text()).resolves.toBe(FILE_BODY);
    expect(dispatchApp).toHaveBeenCalledExactlyOnceWith('site-middleware', expect.any(Request), {
      cpuMs: policy.middleware.cpuMs,
      subRequests: policy.middleware.subRequests,
    });
    expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');

    await waitOnExecutionContext(pending.ctx);
  });

  it('names the resolved fallback policy when matching middleware needed its settings', async () => {
    const dispatchApp = vi.fn(() =>
      Promise.resolve(new Response(null, { headers: { 'x-middleware-next': '1' } })),
    );
    const pending = await delayedPolicyFile({ match: String.raw`^/download\.txt$`, dispatchApp });
    pending.policy.resolve({ kind: 'unavailable' });

    const response = await pending.response;

    await expect(response.text()).resolves.toBe(FILE_BODY);
    expect(response.headers.get('x-arkor-edge')).toContain(`policy=${DEFAULT_DELIVERY_POLICY.id};`);
    expect(dispatchApp).toHaveBeenCalledExactlyOnceWith('site-middleware', expect.any(Request), {
      cpuMs: DEFAULT_DELIVERY_POLICY.middleware.cpuMs,
      subRequests: DEFAULT_DELIVERY_POLICY.middleware.subRequests,
    });

    await waitOnExecutionContext(pending.ctx);
  });

  it('keeps independent middleware fields and cookies named by the configured hop', async () => {
    const dispatchApp = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          headers: {
            'x-middleware-next': '1',
            'x-internal': 'middleware-value',
            'set-cookie': 'middleware=kept; Path=/',
            'access-control-allow-origin': '*',
          },
        }),
      ),
    );
    const pending = await delayedPolicyFile({
      match: String.raw`^/download\.txt$`,
      ruleHeaders: {
        connection: 'X-Internal, Set-Cookie',
        'x-internal': 'rule-only',
        'set-cookie': 'rule=removed; Path=/',
      },
      dispatchApp,
    });
    try {
      pending.policy.resolve({ kind: 'unavailable' });

      const response = await pending.response;

      await expect(response.text()).resolves.toBe(FILE_BODY);
      expect(response.headers.has('connection')).toBe(false);
      expect(response.headers.get('x-internal')).toBe('middleware-value');
      expect(response.headers.getSetCookie()).toStrictEqual(['middleware=kept; Path=/']);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(dispatchApp).toHaveBeenCalledTimes(1);
    } finally {
      pending.policy.resolve({ kind: 'unavailable' });
      await waitOnExecutionContext(pending.ctx);
    }
  });
});
