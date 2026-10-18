import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { EDGE_BYPASS_COOKIE } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

interface Example {
  readonly label: string;
  readonly kind: 'reserved' | 'dynamic' | 'unchanged' | 'bypass';
  readonly condition?: 'has' | 'missing';
  readonly type?: 'header' | 'cookie';
  readonly key?: string;
  readonly value?: string;
  readonly override?: string;
  readonly overrideValue?: string;
  readonly setCookie?: string;
  readonly shell: boolean;
}

async function routedAfterMiddleware(example: Example) {
  const document = pprDocument();
  const pathname = example.kind === 'dynamic' ? '/[slug]' : '/target';
  const condition = {
    type: example.type ?? 'header',
    key: example.key ?? '',
    value: example.value,
  };
  const conditions = { [example.condition ?? 'has']: [condition] };
  const site = await seedSite({
    document,
    pathname,
    bypassFor: example.kind === 'bypass' ? [condition] : undefined,
    reservedRoutes:
      example.kind === 'reserved'
        ? [{ sourceRegex: '^/target$', beforeFiles: true, ...conditions }]
        : undefined,
    dynamicRoutes:
      example.kind === 'dynamic'
        ? [{ sourceRegex: '^/([^/]+)$', route: pathname, ...conditions }]
        : undefined,
  });
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
  };
  const middlewareHeaders = new Headers(
    example.kind === 'unchanged' || example.kind === 'bypass'
      ? { 'x-middleware-next': '1' }
      : { 'x-middleware-rewrite': 'https://site.example/target' },
  );
  if (example.setCookie !== undefined) {
    middlewareHeaders.set('x-middleware-set-cookie', example.setCookie);
  }
  if (example.override !== undefined) {
    middlewareHeaders.set('x-middleware-override-headers', example.override);
    middlewareHeaders.set(
      `x-middleware-request-${example.override}`,
      example.overrideValue ??
        (example.override === 'cookie' ? `theme=${example.value ?? ''}` : (example.value ?? '')),
    );
  }
  const dispatched: Request[] = [];
  const requestPath =
    example.kind === 'unchanged' || example.kind === 'bypass' ? '/target' : '/start';
  const request = navigation(requestPath, {
    headers: {
      'cf-ipcountry': 'XX',
      'x-forwarded-host': 'spoof.example',
      'x-variant': 'client',
      ...(example.key === 'connection' && { connection: 'keep-alive' }),
    },
  });
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime: standaloneRuntime(env, {
        memory: createEdgeMemory(() => Date.now()),
        dispatchApp: (script, handed) => {
          if (script === 'site-middleware') {
            return Promise.resolve(new Response(null, { headers: middlewareHeaders }));
          }
          dispatched.push(handed);
          return Promise.resolve(htmlResponse(document.suffix));
        },
      }),
      host: standaloneHost(env),
      pointer: {
        ...site.pointer,
        app: {
          deploymentId: 'dpl_site',
          scriptName: 'site-app',
          middlewareScriptName: 'site-middleware',
        },
      },
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
      policyLookup: Promise.resolve({
        kind: 'found',
        source: 'exact',
        policy: DEFAULT_DELIVERY_POLICY,
      }),
    },
  );
  await response.text();
  await waitOnExecutionContext(ctx);
  return { response, dispatched };
}

const EXAMPLES: readonly Example[] = [
  {
    label: 'reserved rule sees a removed country header missing',
    kind: 'reserved',
    condition: 'missing',
    key: 'cf-ipcountry',
    shell: false,
  },
  {
    label: 'reserved rule sees the supplied forwarding host',
    kind: 'reserved',
    condition: 'has',
    key: 'x-forwarded-host',
    value: String.raw`site\.example`,
    shell: false,
  },
  {
    label: 'dynamic route refuses a spoofed forwarding host',
    kind: 'dynamic',
    condition: 'has',
    key: 'x-forwarded-host',
    value: String.raw`spoof\.example`,
    shell: false,
  },
  {
    label: 'dynamic route sees a removed country header missing',
    kind: 'dynamic',
    condition: 'missing',
    key: 'cf-ipcountry',
    shell: true,
  },
  {
    label: 'dynamic route preserves the middleware ordinary header override',
    kind: 'dynamic',
    condition: 'has',
    key: 'x-variant',
    value: 'selected',
    override: 'x-variant',
    shell: true,
  },
  {
    label: 'reserved rule preserves the middleware cookie override',
    kind: 'reserved',
    condition: 'has',
    type: 'cookie',
    key: 'theme',
    value: 'dark',
    override: 'cookie',
    shell: false,
  },
  {
    label: 'bypass sees the supplied forwarding host despite a spoofed client value',
    kind: 'bypass',
    key: 'x-forwarded-host',
    value: String.raw`site\.example`,
    shell: false,
  },
  {
    label: 'bypass refuses a client-only forwarding host match',
    kind: 'bypass',
    key: 'x-forwarded-host',
    value: String.raw`spoof\.example`,
    shell: true,
  },
  {
    label: 'bypass cannot read the Connection header removed before dispatch',
    kind: 'bypass',
    key: 'connection',
    shell: true,
  },
  {
    label: 'bypass preserves an ordinary middleware header override',
    kind: 'bypass',
    key: 'x-variant',
    value: 'selected',
    override: 'x-variant',
    shell: false,
  },
  {
    label: 'middleware draft cookie prevents a mixed-mode shell',
    kind: 'unchanged',
    setCookie: '__prerender_bypass=draft; Path=/; HttpOnly',
    shell: false,
  },
  {
    label: 'middleware draft cookie after an Expires date is recognized',
    kind: 'unchanged',
    setCookie:
      'theme=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, __prerender_bypass=draft; Path=/',
    shell: false,
  },
  {
    label: 'middleware Pages preview cookie prevents composition',
    kind: 'unchanged',
    setCookie: '__next_preview_data=preview; Path=/',
    shell: false,
  },
  {
    label: 'middleware instant-navigation test cookie prevents composition',
    kind: 'unchanged',
    setCookie: 'next-instant-navigation-testing=1; Path=/',
    shell: false,
  },
  {
    label: 'middleware edge recovery cookie prevents composition',
    kind: 'unchanged',
    setCookie: `${EDGE_BYPASS_COOKIE}=1; Path=/`,
    shell: false,
  },
  {
    label: 'ordinary combined middleware cookies still allow composition',
    kind: 'unchanged',
    setCookie: 'theme=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, session=abc; Path=/',
    shell: true,
  },
  {
    label: 'a lookalike middleware cookie name is not a bypass name',
    kind: 'unchanged',
    setCookie: 'prefixed__prerender_bypass=value; Path=/',
    shell: true,
  },
  {
    label: 'a bypass-name string inside an ordinary cookie value is not a name',
    kind: 'unchanged',
    setCookie: 'message=__prerender_bypass=lookalike; Path=/',
    shell: true,
  },
  {
    label: 'the raw edge recovery cookie check survives application sanitization',
    kind: 'unchanged',
    override: 'cookie',
    overrideValue: `${EDGE_BYPASS_COOKIE}=1`,
    shell: false,
  },
  {
    label: 'unchanged middleware keeps the already classified page',
    kind: 'unchanged',
    shell: true,
  },
];

describe('routing after middleware uses application forwarding headers', () => {
  it.each(EXAMPLES)('$label', async (example) => {
    const { response, dispatched } = await routedAfterMiddleware(example);

    expect(response.headers.get('x-arkor-edge')?.startsWith('shell;')).toBe(example.shell);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.headers.get('cf-ipcountry')).toBeNull();
    expect(dispatched[0]?.headers.get('x-forwarded-host')).toBe('site.example');
    expect(dispatched[0]?.headers.get('x-middleware-set-cookie')).toBe(example.setCookie ?? null);
  });
});
