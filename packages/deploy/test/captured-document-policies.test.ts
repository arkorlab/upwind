import { deploymentBundleSchema } from '@stayingupwind/core/bundle';
import {
  headerRulesFor,
  parseProjectManifest,
  type ProjectManifest,
  requestHeaderRulesFor,
  serializeManifest,
} from '@stayingupwind/core/manifest';
import { describe, expect, it } from 'vitest';

import { fixtureBundle, rootPrerender } from '../../core/test/fixtures/bundle.ts';
import { assembleManifest } from '../src/manifest.ts';
import { documentHeaderRule } from '../src/routes.ts';

const PATHNAME = '/docs/content-security-policy';
const SOURCE = "'sha256-recovery'";
const POLICY = "script-src 'none'";

async function assembled(): Promise<ProjectManifest> {
  const built = fixtureBundle({
    headerRules: [
      {
        sourceRegex: '^/docs/(.*)$',
        headers: { $1: POLICY },
        has: [{ type: 'header', key: 'x-policy' }],
      },
    ],
  });
  const bundle = deploymentBundleSchema.parse({
    ...built,
    v: 3,
    nextVersion: '16.4.2',
    config: { ...built.config, cacheComponents: true },
    routerReferences: 'one-pass',
    entrypoints: [{ id: PATHNAME, pathname: PATHNAME, kind: 'app-page' }],
    prerenders: [
      {
        ...rootPrerender(),
        id: PATHNAME,
        pathname: PATHNAME,
        route: PATHNAME,
        parentOutputId: PATHNAME,
      },
    ],
  });
  const result = await assembleManifest({
    bundle,
    previous: undefined,
    projectId: 'captured-policy',
    runId: 'run',
    originHost: 'document.example',
    deploymentId: bundle.deploymentId,
    fingerprint: {
      dplId: bundle.deploymentId,
      buildId: bundle.buildId,
      assetSetHash: 'assets',
      observedAt: bundle.generatedAt,
    },
    app: { deploymentId: bundle.deploymentId, scriptName: 'document-app' },
    generatedAt: bundle.generatedAt,
    encodings: new Map(),
    preloads: {},
    recoverySource: SOURCE,
    runtimeCache: false,
  });
  if (result.kind !== 'assembled') throw new Error(result.reason);
  return parseProjectManifest(serializeManifest(result.manifest));
}

describe('deployment preparation for captured document policies', () => {
  it('accepts the trusted captured-key bundle and carries recovery through the stored manifest', async () => {
    const manifest = await assembled();
    const url = new URL(`https://document.example${PATHNAME}`);
    const headers = new Headers({ 'x-policy': 'yes' });
    const judged = requestHeaderRulesFor(manifest, url, headers);

    expect(manifest.routes[PATHNAME]).toBeDefined();
    expect(judged.document.headers['content-security-policy']).toBe(`${POLICY} ${SOURCE}`);
    expect(judged.response.headers['content-security-policy']).toBe(POLICY);
    expect(headerRulesFor(manifest, url, headers).headers['content-security-policy']).toBe(POLICY);
  });

  it('keeps the original captured value for files and non-policy header names', async () => {
    const manifest = await assembled();
    const url = new URL('https://document.example/docs/x-policy');
    const judged = requestHeaderRulesFor(manifest, url, new Headers({ 'x-policy': 'yes' }));

    expect(judged.document.headers['x-policy']).toBe(POLICY);
    expect(judged.document).toStrictEqual(judged.response);
    expect(manifest.headerRules?.[0]?.headers).toStrictEqual({ $1: POLICY });
  });

  it('keeps a captured CSP value as a template until the resolved policy can be widened', () => {
    const rule = documentHeaderRule(
      { sourceRegex: '^/(.*)$', headers: { 'Content-Security-Policy': '$1' } },
      SOURCE,
    );

    expect(rule.headers).toStrictEqual({ 'Content-Security-Policy': '$1' });
    expect(rule.documentHeaders).toBeUndefined();
    expect(rule.documentRecoverySources).toStrictEqual({ 'Content-Security-Policy': SOURCE });
  });

  it('keeps ordinary fixed policies prepared before serving and unrelated rules identical', () => {
    const plain = { sourceRegex: '^/$', headers: { 'X-Policy': POLICY } };
    const fixed = documentHeaderRule(
      { sourceRegex: '^/$', headers: { 'Content-Security-Policy': POLICY } },
      SOURCE,
    );

    expect(documentHeaderRule(plain, SOURCE)).toBe(plain);
    expect(fixed.documentHeaders).toStrictEqual({
      'Content-Security-Policy': `${POLICY} ${SOURCE}`,
    });
    expect(fixed).not.toHaveProperty('documentRecoverySources');
  });
});
