import { appRuntimeSchema } from '@stayingupwind/core/manifest';
import {
  answeredAsCandidate,
  EDGE_DEBUG_HEADER,
  EDGE_VALIDATED_HEADER,
} from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY, edgePointerSchema } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { handlePassthrough } from '../src/handlers/passthrough.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { stateFromPointer } from '../src/preview/state.ts';
import { routeRequest } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const BODY = 'served bytes';
const IDS = [
  { value: 'abcdef0123456789', prefix: 'abcdef01', full: 'abcdef0123456789' },
  { value: 'a:b+_~ z', prefix: 'a:b+_~%20z', full: 'a:b+_~%20z' },
  { value: 'line\r\nbreak', prefix: 'line%5Cr%5Cnbr', full: 'line%5Cr%5Cnbreak' },
  { value: 'nul\0byte', prefix: 'nul%5Cu0000byte', full: 'nul%5Cu0000byte' },
  { value: 'a;b', prefix: 'a%3Bb', full: 'a%3Bb' },
  { value: 'a ', prefix: 'a%20', full: 'a%20' },
  { value: ' a ', prefix: '%20a%20', full: '%20a%20' },
  { value: ' '.repeat(8), prefix: '%20%20%20%20%20%20%20%20', full: '%20%20%20%20%20%20%20%20' },
  { value: '1234567 tail', prefix: '1234567%20', full: '1234567%20tail' },
  { value: 'a%3Bb', prefix: 'a%253Bb', full: 'a%253Bb' },
  { value: '\u{D800}', prefix: '%5Cud800', full: '%5Cud800' },
  { value: '123456😀', prefix: '123456%F0%9F%98%80', full: '123456%F0%9F%98%80' },
  { value: '1234567😀', prefix: '1234567%5Cud83d', full: '1234567%F0%9F%98%80' },
] as const;

async function serve(family: 'document' | 'static' | 'segment', manifestId: string) {
  const document = pprDocument();
  const site = await seedSite({
    document,
    files: { '/manual.txt': BODY },
    segments: { '/_tree': BODY },
  });
  const pointer = edgePointerSchema.parse({ ...site.pointer, manifestId });
  const request = navigation(family === 'static' ? '/manual.txt' : '/', {
    ...(family === 'segment' && {
      headers: {
        rsc: '1',
        'next-router-prefetch': '1',
        'next-router-segment-prefetch': '/_tree',
      },
    }),
  });
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: () => Promise.resolve(htmlResponse(document.suffix)),
  });
  const state = stateFromPointer({
    runtime,
    pointer,
    stored: { kind: 'found', value: site.manifest },
    lookup: { kind: 'found', source: 'exact', policy: DEFAULT_DELIVERY_POLICY },
    pathname: new URL(request.url).pathname,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  const ctx = createExecutionContext();
  // A composing host has already verified its candidate before calling this public entry.
  const response = await routeRequest({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host: standaloneHost(env),
    state: { ...state, validated: true },
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: 0 },
  });
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return {
    response,
    text,
    expected: family === 'document' ? document.shellText + document.suffixText : BODY,
  };
}

describe.each(['document', 'static', 'segment'] as const)('%s manifest diagnostic', (family) => {
  it.each(IDS)('serves and verifies the admitted identity $prefix', async ({ value, prefix }) => {
    const { response, text, expected } = await serve(family, value);
    const debug = response.headers.get(EDGE_DEBUG_HEADER) ?? '';
    const markers = { debug, validated: response.headers.get(EDGE_VALIDATED_HEADER) === '1' };
    const candidate = { manifestId: value, policyId: DEFAULT_DELIVERY_POLICY.id };

    expect(response.status).toBe(200);
    expect(text).toBe(expected);
    expect(debug.split(';')).toContain(`m=${prefix}`);
    expect(answeredAsCandidate(markers, candidate)).toBe(true);
    expect(answeredAsCandidate(markers, { ...candidate, manifestId: 'zzzzzzzz' })).toBe(false);
  });
});

describe('foreground regeneration manifest diagnostics', () => {
  it.each(IDS)(
    'keeps the complete manifest identity $full in one field',
    async ({ value, full }) => {
      const response = await handlePassthrough({
        request: new Request('https://site.example/'),
        forwarding: { previewDomain: 'example', previewHost: 'site.example', clientIp: undefined },
        runtime: standaloneRuntime(env, { dispatchApp: () => Promise.resolve(new Response(BODY)) }),
        host: standaloneHost(env),
        app: { deploymentId: 'dpl_ordinary', scriptName: 'ordinary-app' },
        reason: 'regenerate',
        metrics: {
          projectId: 'site',
          manifestId: value,
          policyId: 'policy',
          pathname: '/',
          colo: '',
        },
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe(BODY);
      expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe(
        `passthrough;reason=regenerate;m=${full};policy=policy;scope=dpl_ordinary`,
      );
    },
  );
});

describe('foreground regeneration scope diagnostics', () => {
  it.each(IDS)(
    'keeps the admitted deployment identity $full in one field',
    async ({ value, full }) => {
      const app = appRuntimeSchema.parse({ deploymentId: value, scriptName: 'ordinary-app' });
      const response = await handlePassthrough({
        request: new Request('https://site.example/'),
        forwarding: { previewDomain: 'example', previewHost: 'site.example', clientIp: undefined },
        runtime: standaloneRuntime(env, { dispatchApp: () => Promise.resolve(new Response(BODY)) }),
        host: standaloneHost(env),
        app,
        reason: 'regenerate',
        metrics: {
          projectId: 'site',
          manifestId: 'ordinary',
          policyId: 'policy',
          pathname: '/',
          colo: '',
        },
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe(BODY);
      expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe(
        `passthrough;reason=regenerate;m=ordinary;policy=policy;scope=${full}`,
      );
    },
  );
});
