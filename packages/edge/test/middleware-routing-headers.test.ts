import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  deriveEntry,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import type { DynamicRoute, ProjectManifest } from '@stayingupwind/core/manifest';
import { EDGE_BYPASS_COOKIE } from '@stayingupwind/core/request';
import { encodeUtf8 } from '@stayingupwind/core/util';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
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
  readonly member?: boolean;
  readonly headersOnly?: boolean;
}

/** A complete saved member, so serving it needs no resume dispatch to the application. */
async function seedMemberRecord(document: ReturnType<typeof pprDocument>, scopeId: string) {
  const pathname = '/target';
  const route = '/[slug]';
  const { entryId } = await deriveEntry(scopeId, { kind: 'app-page', route, pathname });
  const html = encodeUtf8(document.shellText + document.suffixText);
  const now = Date.now();
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId,
      entryId,
      generationId: 'gen_member',
      seq: 1,
      revision: 1,
      source: 'runtime',
      kind: 'app-page',
      route,
      pathname,
      cacheTimestamp: now,
      producedAt: now,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    html,
    undefined,
  );
  await env.CACHE_STATE.put(kvGenerationKey(scopeId, entryId), bytes);
}

/** The response protocol emitted by this fixture's middleware. */
function middlewareHeadersFor(example: Example): Headers {
  const middlewareHeaders = new Headers(
    example.headersOnly === true || example.kind === 'unchanged' || example.kind === 'bypass'
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
  return middlewareHeaders;
}

/** The build shell is deliberately unrelated when this fixture serves a saved member. */
function shellPathname(example: Example): string {
  if (example.member === true) return '/unrelated';
  return example.kind === 'dynamic' ? '/[slug]' : '/target';
}

/** Match the same concrete path either to a class shell or to a class with only member records. */
function dynamicRoutesFor(
  example: Example,
  condition: NonNullable<DynamicRoute['has']>[number],
  pathname: string,
): readonly DynamicRoute[] | undefined {
  const conditions = { [example.condition ?? 'has']: [condition] };
  if (example.member === true) {
    return [
      {
        sourceRegex: '^/target$',
        members: { route: '/[slug]', kind: 'app-page' },
        ...(example.kind === 'dynamic' && conditions),
      },
    ];
  }
  return example.kind === 'dynamic'
    ? [{ sourceRegex: '^/([^/]+)$', route: pathname, ...conditions }]
    : undefined;
}

async function routedAfterMiddleware(example: Example) {
  const document = pprDocument();
  const member = example.member === true;
  const pathname = shellPathname(example);
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
    dynamicRoutes: dynamicRoutesFor(example, condition, pathname),
  });
  const scopeId = `member-${example.label}`;
  if (member) await seedMemberRecord(document, scopeId);
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
    ...(member && { cache: { keySchemaVersion: 1, scopeId } }),
  };
  const middlewareHeaders = middlewareHeadersFor(example);
  const dispatched: Request[] = [];
  const requestPath =
    example.headersOnly === true || example.kind === 'unchanged' || example.kind === 'bypass'
      ? '/target'
      : '/start';
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
        policy: member
          ? {
              ...DEFAULT_DELIVERY_POLICY,
              runtimeCache: {
                ...DEFAULT_RUNTIME_CACHE_SETTINGS,
                generations: 'on',
                cacheApiMaxAgeMs: 0,
              },
            }
          : DEFAULT_DELIVERY_POLICY,
      }),
    },
  );
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, dispatched, body, document };
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

const MEMBER_EXAMPLES: readonly Example[] = [
  {
    label: 'a rewrite respects a beforeFiles rule on a removed country header',
    kind: 'reserved',
    condition: 'missing',
    key: 'cf-ipcountry',
    member: true,
    shell: false,
  },
  {
    label: 'a header-only change respects the same beforeFiles rule',
    kind: 'reserved',
    condition: 'missing',
    key: 'cf-ipcountry',
    override: 'cf-ipcountry',
    value: 'XX',
    headersOnly: true,
    member: true,
    shell: false,
  },
  {
    label: 'a member condition cannot match a spoofed forwarding host',
    kind: 'dynamic',
    key: 'x-forwarded-host',
    value: String.raw`spoof\.example`,
    member: true,
    shell: false,
  },
  {
    label: 'a member condition sees the actual forwarding host',
    kind: 'dynamic',
    key: 'x-forwarded-host',
    value: String.raw`site\.example`,
    member: true,
    shell: true,
  },
  {
    label: 'a member condition preserves an ordinary middleware override',
    kind: 'dynamic',
    key: 'x-variant',
    value: 'selected',
    override: 'x-variant',
    member: true,
    shell: true,
  },
  {
    label: 'an unchanged middleware still serves the saved member',
    kind: 'unchanged',
    member: true,
    shell: true,
  },
  {
    label: 'a raw edge recovery cookie still bypasses the saved member',
    kind: 'unchanged',
    override: 'cookie',
    overrideValue: `${EDGE_BYPASS_COOKIE}=1`,
    member: true,
    shell: false,
  },
];

describe('saved members share the routing headers selected after middleware', () => {
  it.each(MEMBER_EXAMPLES)('$label', async (example) => {
    const { response, dispatched, body, document } = await routedAfterMiddleware(example);

    expect(response.headers.get('x-arkor-edge')?.includes(';member=1')).toBe(example.shell);
    expect(dispatched).toHaveLength(example.shell ? 0 : 1);
    expect(body).toBe(
      example.shell ? document.shellText + document.suffixText : document.suffixText,
    );
  });
});
