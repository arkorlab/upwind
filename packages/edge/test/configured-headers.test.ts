import { HEADER_RULES_LEFT_HEADER } from '@stayingupwind/core/paas';
import type { ForwardingContext } from '@stayingupwind/core/request';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { handlePassthrough } from '../src/handlers/passthrough.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';

const SCOPE: ForwardingContext = {
  previewDomain: 'example.test',
  previewHost: 'customer.example.test',
  clientIp: undefined,
};
const ORIGINAL_COOKIE = 'own=1; Path=/';
const RULE_COOKIE = 'rule=1; Path=/';
const MIDDLEWARE_COOKIE = 'mw=1; Path=/';

/** A Function answer after the edge ran middleware and judged the request's header rules. */
async function handedOn(answer: Response, middlewareHeaders = new Headers()): Promise<Response> {
  const request = new Request('https://customer.example.test/api/hello');
  return handlePassthrough({
    request,
    forwarding: SCOPE,
    runtime: standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: () => Promise.resolve(answer),
    }),
    host: standaloneHost(env),
    app: { deploymentId: 'dpl_site', scriptName: 'site-app' },
    reason: 'route-not-proved',
    middleware: {
      kind: 'continue',
      url: new URL(request.url),
      rewritten: false,
      requestHeaders: request.headers,
      responseHeaders: middlewareHeaders,
      setCookie: undefined,
      judgedRules: {
        headers: {
          'x-rule': 'configured',
          'x-precedence': 'configured',
          'set-cookie': RULE_COOKIE,
        },
        conditioned: false,
      },
    },
  });
}

/** The route's own response; a runtime from before the handshake lays the rules itself. */
function functionAnswer(leaves: boolean, connection?: string): Response {
  const headers = new Headers({
    'x-rule': 'origin',
    'x-precedence': 'origin',
    'set-cookie': ORIGINAL_COOKIE,
  });
  if (leaves) headers.set(HEADER_RULES_LEFT_HEADER, '1');
  if (connection !== undefined) headers.set('connection', connection);
  return new Response('from the Function', { headers });
}

describe('deferred configured headers', () => {
  it('keeps a Function-nominated rule off the forwarded answer', async () => {
    const origin = functionAnswer(true, 'X-Rule, , not a name');
    const original = [...origin.headers];
    const response = await handedOn(origin);

    expect(response.headers.get('x-rule')).toBeNull();
    expect(response.headers.get('connection')).toBeNull();
    expect(response.headers.get('x-precedence')).toBe('configured');
    expect(response.headers.getSetCookie()).toStrictEqual([ORIGINAL_COOKIE, RULE_COOKIE]);
    expect([...origin.headers]).toStrictEqual(original);
    await expect(response.text()).resolves.toBe('from the Function');
  });

  it('keeps nominated rule cookies off while retaining independent middleware cookies', async () => {
    const middleware = new Headers({ 'set-cookie': MIDDLEWARE_COOKIE });
    const response = await handedOn(functionAnswer(true, 'Set-Cookie'), middleware);

    expect(response.headers.getSetCookie()).toStrictEqual([MIDDLEWARE_COOKIE]);
    expect(response.headers.get('x-rule')).toBe('configured');
  });

  it('retains independent middleware fields after dropping the nominated configured rule', async () => {
    const response = await handedOn(
      functionAnswer(true, 'X-Rule'),
      new Headers({ 'x-rule': 'middleware' }),
    );

    expect(response.headers.get('x-rule')).toBe('middleware');
  });

  it('keeps ordinary rule and middleware precedence and cookie order without Connection', async () => {
    const response = await handedOn(
      functionAnswer(true),
      new Headers({ 'x-precedence': 'middleware', 'set-cookie': MIDDLEWARE_COOKIE }),
    );

    expect(response.headers.get('x-rule')).toBe('configured');
    expect(response.headers.get('x-precedence')).toBe('middleware');
    expect(response.headers.getSetCookie()).toStrictEqual([
      ORIGINAL_COOKIE,
      RULE_COOKIE,
      MIDDLEWARE_COOKIE,
    ]);
    expect(response.headers.has(HEADER_RULES_LEFT_HEADER)).toBe(false);
  });

  it('leaves rules to a Function that did not defer them', async () => {
    const response = await handedOn(functionAnswer(false, 'X-Rule'));

    expect(response.headers.get('x-rule')).toBeNull();
    expect(response.headers.get('x-precedence')).toBe('origin');
    expect(response.headers.getSetCookie()).toStrictEqual([ORIGINAL_COOKIE]);
  });
});
