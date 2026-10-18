import {
  buildProjectManifest,
  computeManifestId,
  type HeaderRule,
  requestHeaderRulesFor,
  serializeManifest,
} from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import {
  buildRecoveryHtml,
  identityWire,
  LEGACY_RECOVERY_SCRIPT_CSP_SOURCE,
  RECOVERY_SCRIPT_CSP_SOURCE,
} from '@stayingupwind/host/splice';
import { kvManifestKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  documentHeaders,
  foldedAsSet,
  foldedHeadersOf,
  replayedDocumentHeaders,
} from '../src/handlers/document-headers.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const PATHNAME = '/docs/content-security-policy';
const URL_TEXT = `https://site.example${PATHNAME}`;
const CSP = 'content-security-policy';
const REPORT_ONLY = 'content-security-policy-report-only';
const OLD_POLICY = `script-src 'self' ${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE}`;
const CURRENT_POLICY = `script-src 'self' ${RECOVERY_SCRIPT_CSP_SOURCE}`;
const OLD_CAPTURED = `script-src 'none' ${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE}`;
const CURRENT_CAPTURED = `script-src 'none' ${RECOVERY_SCRIPT_CSP_SOURCE}`;

interface Example {
  readonly name: string;
  readonly recorded: Readonly<Record<string, string>>;
  readonly headerRules?: readonly HeaderRule[];
  readonly foldedHeaderRules?: readonly HeaderRule[];
  readonly before: string;
  readonly after: string;
}

/** Use the actual rule replay and final composition boundary, without a rendering or a fake hash. */
function composed(example: Example, complete = false, middlewareHeaders?: Headers) {
  const manifest = buildProjectManifest({
    projectId: 'recovery-compat',
    runId: 'run',
    originHost: 'site.example',
    generatedAt: '2026-10-18T00:00:00.000Z',
    deployment: { assetSetHash: 'assets', observedAt: '2026-10-18T00:00:00.000Z' },
    app: { deploymentId: 'dpl_site', scriptName: 'site-app' },
    routes: [
      {
        pathname: PATHNAME,
        status: 200,
        shell: {
          sha256: 'a'.repeat(64),
          byteLength: 0,
          contentType: 'text/html; charset=utf-8',
          encoding: 'identity',
        },
        headers: { 'content-type': 'text/html; charset=utf-8', ...example.recorded },
        prerenderId: PATHNAME,
      },
    ],
    ...(example.headerRules !== undefined && { headerRules: [...example.headerRules] }),
    ...(example.foldedHeaderRules !== undefined && {
      foldedHeaderRules: [...example.foldedHeaderRules],
    }),
  });
  const entry = manifest.routes[PATHNAME];
  if (entry === undefined) throw new Error('the fixture must retain its document');
  const original = JSON.stringify(manifest);
  const folded = foldedHeadersOf(complete ? foldedAsSet(manifest) : manifest, PATHNAME);
  const judged = requestHeaderRulesFor(manifest, new URL(URL_TEXT), new Headers());
  const prepared = replayedDocumentHeaders(
    { ...entry.headers, ...folded },
    complete ? judged.response : judged.document,
  );
  const before = prepared.get(CSP);
  const edge: EdgeContext = {
    env,
    ctx: createExecutionContext(),
    runtime: standaloneRuntime(env, { memory: createEdgeMemory(() => 0) }),
    host: standaloneHost(env),
    forwarding: { previewDomain: 'example', previewHost: 'site.example', clientIp: undefined },
    app: manifest.app,
    originalUrl: undefined,
    policy: DEFAULT_DELIVERY_POLICY,
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: false,
    assetMaxBytes: 1_000_000,
    projectId: manifest.projectId,
    manifestId: 'manifest-recovery',
    colo: undefined,
    validated: false,
    demotedRoutes: undefined,
    privateDelivery: false,
    timings: { pointerMs: undefined, manifestMs: undefined, middlewareMs: undefined },
  };
  const { headers } = documentHeaders({
    entry,
    complete,
    headers: prepared,
    edge,
    strategyId: 'fixture',
    shell: {
      source: 'fixture',
      lookupMs: 0,
      encoding: 'identity',
      wire: identityWire(new Uint8Array()),
      outbound: 'none',
      variesByAgent: false,
    },
    mintNonce: undefined,
    hosted: 'cont=resume',
    middleware:
      middlewareHeaders === undefined
        ? undefined
        : {
            kind: 'continue',
            url: new URL(URL_TEXT),
            rewritten: false,
            requestHeaders: new Headers(),
            responseHeaders: middlewareHeaders,
            setCookie: undefined,
          },
    nextCache: undefined,
    cacheControl: 'no-store',
    record: undefined,
  });
  return { before, headers, unchanged: JSON.stringify(manifest) === original };
}

const EXAMPLES: readonly Example[] = [
  {
    name: 'the old entry',
    recorded: { [CSP]: OLD_POLICY },
    before: OLD_POLICY,
    after: CURRENT_POLICY,
  },
  {
    name: 'a literal configured override of a current generation policy',
    recorded: { [CSP]: CURRENT_POLICY },
    headerRules: [
      {
        sourceRegex: '^/docs/(.*)$',
        headers: { [CSP]: "script-src 'none'" },
        documentHeaders: { [CSP]: OLD_POLICY },
      },
    ],
    before: OLD_POLICY,
    after: CURRENT_POLICY,
  },
  {
    name: 'an old folded override of a current generation policy',
    recorded: { [CSP]: CURRENT_POLICY },
    foldedHeaderRules: [
      {
        sourceRegex: '^/docs/(.*)$',
        headers: { [CSP]: "script-src 'none'" },
        documentHeaders: { [CSP]: OLD_POLICY },
      },
    ],
    before: OLD_POLICY,
    after: CURRENT_POLICY,
  },
  {
    name: 'a captured policy widened by an old source map',
    recorded: { [CSP]: CURRENT_POLICY },
    headerRules: [
      {
        sourceRegex: '^/docs/(.*)$',
        headers: { $1: "script-src 'none'" },
        documentRecoverySources: { $1: LEGACY_RECOVERY_SCRIPT_CSP_SOURCE },
      },
    ],
    before: OLD_CAPTURED,
    after: CURRENT_CAPTURED,
  },
  {
    name: 'a captured folded policy widened by an old source map',
    recorded: { [CSP]: CURRENT_POLICY },
    foldedHeaderRules: [
      {
        sourceRegex: '^/docs/(.*)$',
        headers: { $1: "script-src 'none'" },
        documentRecoverySources: { $1: LEGACY_RECOVERY_SCRIPT_CSP_SOURCE },
      },
    ],
    before: OLD_CAPTURED,
    after: CURRENT_CAPTURED,
  },
];

/** A stored old manifest and a failing continuation, through the actual public document entry. */
async function storedDocument(mode: 'entry' | 'literal') {
  const site = await seedSite({ document: pprDocument(), pathname: PATHNAME });
  const entry = site.manifest.routes[PATHNAME];
  if (entry === undefined) throw new Error('the fixture must retain its stored document');
  const manifest = {
    ...site.manifest,
    routes: {
      ...site.manifest.routes,
      [PATHNAME]: {
        ...entry,
        headers: { ...entry.headers, [CSP]: mode === 'entry' ? OLD_POLICY : CURRENT_POLICY },
      },
    },
    ...(mode === 'literal' && {
      headerRules: [
        {
          sourceRegex: '^/docs/(.*)$',
          headers: { [CSP]: "script-src 'none'" },
          documentHeaders: { [CSP]: OLD_POLICY },
        },
      ],
    }),
  };
  const manifestId = await computeManifestId(manifest);
  await env.EDGE_STATE.put(kvManifestKey(manifestId), serializeManifest(manifest));
  const ctx = createExecutionContext();
  const request = navigation(PATHNAME, { headers: { 'accept-encoding': 'identity' } });
  let calls = 0;
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime: standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: () => {
        calls += 1;
        return Promise.reject(new Error('the continuation failed'));
      },
    }),
    host: standaloneHost(env),
    pointer: { ...site.pointer, manifestId },
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body, calls };
}

describe('recovery permission after final document policy overrides', () => {
  it.each(EXAMPLES)('rotates $name without changing the immutable manifest', (example) => {
    const result = composed(example);

    expect(result.before).toBe(example.before);
    expect(result.headers.get(CSP)).toBe(example.after);
    expect(result.unchanged).toBe(true);
  });

  it('rotates a replacing middleware policy after the configured policy', () => {
    const result = composed(
      {
        name: 'middleware',
        recorded: { [CSP]: CURRENT_POLICY },
        before: CURRENT_POLICY,
        after: CURRENT_POLICY,
      },
      false,
      new Headers({ [CSP]: OLD_CAPTURED }),
    );

    expect(result.before).toBe(CURRENT_POLICY);
    expect(result.headers.get(CSP)).toBe(CURRENT_CAPTURED);
  });

  it('leaves the old permission of a complete document exactly as it was', () => {
    const result = composed(
      { name: 'complete', recorded: { [CSP]: OLD_POLICY }, before: OLD_POLICY, after: OLD_POLICY },
      true,
    );

    expect(result.headers.get(CSP)).toBe(OLD_POLICY);
  });

  it('leaves report-only and unrelated enforcing policies exactly as they were', () => {
    const policy = "script-src 'sha256-unrelated'";
    const result = composed({
      name: 'unrelated',
      recorded: { [CSP]: policy, [REPORT_ONLY]: OLD_POLICY },
      before: policy,
      after: policy,
    });

    expect(result.headers.get(CSP)).toBe(policy);
    expect(result.headers.get(REPORT_ONLY)).toBe(OLD_POLICY);
  });

  it('does not invent an enforcing policy beside a report-only policy', () => {
    const result = composed({
      name: 'report-only',
      recorded: { [REPORT_ONLY]: OLD_POLICY },
      before: '',
      after: '',
    });

    expect(result.before).toBeNull();
    expect(result.headers.get(CSP)).toBeNull();
    expect(result.headers.get(REPORT_ONLY)).toBe(OLD_POLICY);
  });

  it.each(['entry', 'literal'] as const)(
    'permits the actual new recovery script for a stored old %s policy',
    async (mode) => {
      const result = await storedDocument(mode);

      expect(result.calls).toBe(1);
      expect(result.response.status).toBe(200);
      expect(result.response.headers.get(CSP)).toBe(CURRENT_POLICY);
      expect(result.body).toContain(buildRecoveryHtml());
    },
  );

  it('keeps a static file outside document policy rotation at the public entry', async () => {
    const site = await seedSite({
      document: pprDocument(),
      files: { '/manual.txt': 'the manual' },
      headerRules: [{ sourceRegex: '^/manual\\.txt$', headers: { [CSP]: OLD_POLICY } }],
    });
    const ctx = createExecutionContext();
    const request = navigation('/manual.txt');
    const response = await serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        runtime: standaloneRuntime(env, { memory: createEdgeMemory(() => Date.now()) }),
        host: standaloneHost(env),
        pointer: site.pointer,
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      },
      {
        manifestLookup: Promise.resolve({ kind: 'found', value: site.manifest }),
        policyLookup: Promise.resolve({
          kind: 'found',
          policy: DEFAULT_DELIVERY_POLICY,
          source: 'exact',
        }),
      },
    );
    const body = await response.text();
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get(CSP)).toBe(OLD_POLICY);
    expect(body).toBe('the manual');
  });
});
