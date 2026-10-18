import type { MiddlewareMatcher } from '@stayingupwind/core/manifest';
import type { ForwardingContext } from '@stayingupwind/core/request';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { buildPassthroughRequest } from '../src/forwarding.ts';
import { routedHeaders } from '../src/handlers/middleware.ts';
import { standaloneHost } from '../src/standalone/index.ts';

const FORWARDING: ForwardingContext = {
  previewDomain: 'example.test',
  previewHost: 'customer.example.test',
  clientIp: undefined,
};
const HOST = standaloneHost(env);
const EDGE = { host: HOST, forwarding: FORWARDING };
const CUSTOM_RULE: readonly MiddlewareMatcher[] = [
  { sourceRegex: '^/$', missing: [{ type: 'header', key: 'x-route' }] },
];

describe('routing headers after forwarding', () => {
  it('judges a Connection-nominated field as the actual passthrough sends it', () => {
    const headers = new Headers({ connection: 'X-Route, , not a name', 'x-route': 'client' });
    const request = new Request('https://customer.example.test/', { headers });
    const forwarded = buildPassthroughRequest(request, FORWARDING, HOST.credentials);

    expect(routedHeaders(EDGE, CUSTOM_RULE, headers).get('x-route')).toBe(
      forwarded.headers.get('x-route'),
    );
    expect(headers.get('x-route')).toBe('client');
  });

  it.each(['WebSocket', 'h2c'])(
    'judges Upgrade=%s as the actual passthrough sends it',
    (upgrade) => {
      const request = new Request('https://customer.example.test/', {
        headers: { connection: 'Upgrade', upgrade },
      });
      const rules: readonly MiddlewareMatcher[] = [
        { sourceRegex: '^/$', has: [{ type: 'header', key: 'Upgrade', value: 'websocket' }] },
      ];
      const forwarded = buildPassthroughRequest(request, FORWARDING, HOST.credentials);

      expect(routedHeaders(EDGE, rules, request.headers).get('upgrade')).toBe(
        forwarded.headers.get('upgrade'),
      );
    },
  );

  it('takes host-owned Upgrade off after canonical restoration', () => {
    const host = { ...HOST, credentials: { headers: ['Upgrade'], cookies: [] } };
    const headers = new Headers({ upgrade: 'websocket' });
    const rules: readonly MiddlewareMatcher[] = [
      { sourceRegex: '^/$', has: [{ type: 'header', key: 'Upgrade' }] },
    ];

    expect(routedHeaders({ ...EDGE, host }, rules, headers).get('upgrade')).toBeNull();
  });

  it.each([{}, { connection: 'keep-alive, not a name' }])(
    'keeps ordinary rsc and custom-condition headers without a normalized copy: %j',
    (transport) => {
      const headers = new Headers({ rsc: '1', 'x-route': 'client', ...transport });
      const rules: readonly MiddlewareMatcher[] = [
        { sourceRegex: '^/$', has: [{ type: 'header', key: 'rsc' }] },
        ...CUSTOM_RULE,
      ];

      expect(routedHeaders(EDGE, rules, headers)).toBe(headers);
      expect(routedHeaders(EDGE, rules, headers)).toBe(headers);
    },
  );
});
