import { HEADER_RULES_LEFT_HEADER } from '@stayingupwind/core/paas';
import { RSC_HEADER } from '@stayingupwind/core/request';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { handlePassthrough } from '../src/handlers/passthrough.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';

const REWRITTEN_PATH = 'x-nextjs-rewritten-path';
const FINAL_PATH = '/en/(.)foo/p/1';
const MIDDLEWARE_PATH = '/en/foo/p/1';
const BODY = new TextEncoder().encode('opaque streamed payload');

interface Example {
  readonly originPath?: string;
  readonly configured?: boolean;
  readonly configuredNomination?: boolean;
  readonly nominated?: boolean;
  readonly clientRsc?: boolean;
  readonly middlewareRsc?: boolean;
}

/** The real passthrough merges the Function's answer after middleware already selected its route. */
function answered(example: Example): Promise<Response> {
  const request = new Request('https://site.example/foo/p/1', {
    headers: example.clientRsc === false ? {} : { [RSC_HEADER]: '1' },
  });
  const requestHeaders = new Headers(request.headers);
  if (example.middlewareRsc === true) {
    requestHeaders.set(RSC_HEADER, '1');
  } else if (example.middlewareRsc === false) {
    requestHeaders.delete(RSC_HEADER);
  }
  const headers = new Headers({
    'content-type': 'text/x-component',
    'x-ordinary': 'origin',
    'set-cookie': 'origin=1; Path=/',
  });
  if (example.originPath !== undefined) headers.set(REWRITTEN_PATH, example.originPath);
  if (example.nominated === true) headers.set('connection', REWRITTEN_PATH);
  if (example.configured === true) headers.set(HEADER_RULES_LEFT_HEADER, '1');
  const origin = new Response(BODY, { headers });
  return handlePassthrough({
    request,
    forwarding: { previewDomain: 'invalid', previewHost: 'site.example', clientIp: undefined },
    runtime: standaloneRuntime(env, { dispatchApp: () => Promise.resolve(origin) }),
    host: standaloneHost(env),
    app: { deploymentId: 'dpl_site', scriptName: 'site-app' },
    reason: 'rsc-payload',
    middleware: {
      kind: 'continue',
      rewritten: true,
      setCookie: undefined,
      url: new URL(MIDDLEWARE_PATH, request.url),
      requestHeaders,
      responseHeaders: new Headers({
        [REWRITTEN_PATH]: MIDDLEWARE_PATH,
        'x-ordinary': 'middleware',
        'set-cookie': 'middleware=1; Path=/',
      }),
      ...(example.configured === true && {
        judgedRules: {
          conditioned: false,
          headers: {
            [REWRITTEN_PATH]: '/configured',
            'x-ordinary': 'configured',
            ...(example.configuredNomination === true && { connection: REWRITTEN_PATH }),
          },
        },
      }),
    },
  });
}

describe('the final RSC rewritten path after middleware', () => {
  it.each([false, true])(
    'keeps the final Function path over provisional overlays (deferred rules: %s)',
    async (configured) => {
      const response = await answered({ originPath: FINAL_PATH, configured });

      expect(response.headers.get(REWRITTEN_PATH)).toBe(FINAL_PATH);
      expect(response.headers.get('x-ordinary')).toBe('middleware');
      expect(response.headers.getSetCookie()).toStrictEqual([
        'origin=1; Path=/',
        'middleware=1; Path=/',
      ]);
      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
    },
  );

  it('does not restore a final path removed by a deferred Connection option', async () => {
    const response = await answered({
      originPath: FINAL_PATH,
      configured: true,
      configuredNomination: true,
    });

    expect(response.headers.get(REWRITTEN_PATH)).toBe(MIDDLEWARE_PATH);
    expect(response.headers.has('connection')).toBe(false);
    expect(response.headers.get('x-ordinary')).toBe('middleware');
  });

  it.each([false, true])(
    'keeps the middleware path when no final path survived forwarding (nominated: %s)',
    async (nominated) => {
      const response = await answered({ nominated, ...(nominated && { originPath: FINAL_PATH }) });

      expect(response.headers.get(REWRITTEN_PATH)).toBe(MIDDLEWARE_PATH);
      expect(response.headers.has('connection')).toBe(false);
      expect(response.headers.get('x-ordinary')).toBe('middleware');
    },
  );

  it.each([
    { clientRsc: false, middlewareRsc: true, expected: FINAL_PATH },
    { clientRsc: true, middlewareRsc: false, expected: MIDDLEWARE_PATH },
    { clientRsc: false, expected: MIDDLEWARE_PATH },
  ])('uses the request kind the Function receives: %j', async (example) => {
    const response = await answered({ originPath: FINAL_PATH, ...example });

    expect(response.headers.get(REWRITTEN_PATH)).toBe(example.expected);
    expect(response.headers.get('x-ordinary')).toBe('middleware');
  });
});
