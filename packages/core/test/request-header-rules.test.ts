import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  documentHeaderRulesFor,
  foldedHeadersFor,
  headerRulesFor,
  requestHeaderRulesFor,
} from '../src/manifest/dynamic.ts';
import {
  buildProjectManifest,
  parseProjectManifest,
  serializeManifest,
} from '../src/manifest/manifest.ts';
import type { HeaderRule, ProjectManifest } from '../src/manifest/schema.ts';
import {
  budgetPatterns,
  createPatternBudget,
  type PatternBudget,
  PatternBudgetExceededError,
} from '../src/request/pattern-budget.ts';

const OBSERVED_AT = '2026-10-15T00:00:00.000Z';
const RECOVERY_SOURCE = "'sha256-recovery'";
const POLICY = "script-src 'none'";
const PERMITTED_POLICY = `${POLICY} ${RECOVERY_SOURCE}`;

function manifestFor(headerRules?: readonly HeaderRule[]): ProjectManifest {
  return buildProjectManifest({
    projectId: 'p',
    runId: 'r',
    generatedAt: OBSERVED_AT,
    originHost: 'app.example',
    deployment: { dplId: 'dpl_active', assetSetHash: 'h', observedAt: OBSERVED_AT },
    routes: [],
    app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
    headerRules,
    routerReferences: 'one-pass',
  });
}

describe('one judgement of a request’s response and document header rules', () => {
  let current: PatternBudget | undefined;

  beforeAll(() => {
    budgetPatterns(() => current);
  });

  afterEach(() => {
    current = undefined;
  });

  it('sets nothing when the manifest has no rules', () => {
    expect(
      requestHeaderRulesFor(manifestFor(), new URL('https://app.example/'), new Headers()),
    ).toStrictEqual({
      response: { headers: {}, conditioned: false },
      document: { headers: {}, conditioned: false },
    });
  });

  it('applies later rules in order and replaces each document rule’s entire header set', () => {
    const manifest = manifestFor([
      {
        sourceRegex: '^/docs$',
        headers: {
          'Content-Security-Policy': 'ordinary',
          'X-Only-Response': 'yes',
          'X-Order': 'first',
        },
        documentHeaders: { 'Content-Security-Policy': 'document', 'X-Order': 'document-first' },
      },
      { sourceRegex: '^/docs$', headers: { 'x-order': 'last', 'X-Common': 'both' } },
    ]);

    expect(
      requestHeaderRulesFor(manifest, new URL('https://app.example/docs'), new Headers()),
    ).toStrictEqual({
      response: {
        headers: {
          'content-security-policy': 'ordinary',
          'x-only-response': 'yes',
          'x-order': 'last',
          'x-common': 'both',
        },
        conditioned: false,
      },
      document: {
        headers: { 'content-security-policy': 'document', 'x-order': 'last', 'x-common': 'both' },
        conditioned: false,
      },
    });
  });

  it('interpolates names and values for both forms from the same captures', () => {
    const manifest = manifestFor([
      {
        sourceRegex: '^/docs/(?<slug>[^/]+)$',
        headers: { 'X-$1': ':slug / $1' },
        documentHeaders: { 'Y-$1': '$1 / :slug' },
      },
    ]);

    expect(
      requestHeaderRulesFor(manifest, new URL('https://app.example/DOCS/acme'), new Headers()),
    ).toStrictEqual({
      response: { headers: { 'x-acme': 'acme / acme' }, conditioned: false },
      document: { headers: { 'y-acme': 'acme / acme' }, conditioned: false },
    });
  });

  it('shares has and missing judgements and records only matched conditions', () => {
    const manifest = manifestFor([
      {
        sourceRegex: '^/docs$',
        has: [{ type: 'header', key: 'x-beta', value: 'yes' }],
        missing: [{ type: 'cookie', key: 'session' }],
        headers: { 'X-Response': 'visitor' },
        documentHeaders: { 'X-Document': 'visitor' },
      },
    ]);
    const url = new URL('https://app.example/docs');

    expect(requestHeaderRulesFor(manifest, url, new Headers({ 'x-beta': 'yes' }))).toStrictEqual({
      response: { headers: { 'x-response': 'visitor' }, conditioned: true },
      document: { headers: { 'x-document': 'visitor' }, conditioned: true },
    });
    expect(
      requestHeaderRulesFor(
        manifest,
        url,
        new Headers({ 'x-beta': 'yes', cookie: 'session=active' }),
      ),
    ).toStrictEqual({
      response: { headers: {}, conditioned: false },
      document: { headers: {}, conditioned: false },
    });
  });

  it('keeps an empty matched conditional rule conditioned in both forms', () => {
    const manifest = manifestFor([
      {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'x-beta' }],
        headers: {},
        documentHeaders: {},
      },
    ]);

    expect(
      requestHeaderRulesFor(
        manifest,
        new URL('https://app.example/'),
        new Headers({ 'x-beta': '1' }),
      ),
    ).toStrictEqual({
      response: { headers: {}, conditioned: true },
      document: { headers: {}, conditioned: true },
    });
  });

  it('spends one allowance on a source pattern for both forms', () => {
    current = createPatternBudget();
    const manifest = manifestFor([{ sourceRegex: '^/a+a+!$', headers: { 'X-Result': 'matched' } }]);
    const url = new URL(`https://app.example/${'a'.repeat(700)}`);
    const headers = new Headers();

    expect(requestHeaderRulesFor(manifest, url, headers)).toStrictEqual({
      response: { headers: {}, conditioned: false },
      document: { headers: {}, conditioned: false },
    });
    expect(() => headerRulesFor(manifest, url, headers)).toThrow(PatternBudgetExceededError);
  });

  it('spends one allowance on a condition pattern for both forms', () => {
    current = createPatternBudget();
    const manifest = manifestFor([
      {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'x-value', value: '^a+a+$' }],
        headers: { 'X-Result': 'matched' },
      },
    ]);
    const url = new URL('https://app.example/');
    const headers = new Headers({ 'x-value': 'a'.repeat(700) });

    expect(requestHeaderRulesFor(manifest, url, headers)).toStrictEqual({
      response: { headers: { 'x-result': 'matched' }, conditioned: true },
      document: { headers: { 'x-result': 'matched' }, conditioned: true },
    });
    expect(() => headerRulesFor(manifest, url, headers)).toThrow(PatternBudgetExceededError);
  });
});

describe('recovery sources for policies resolved from captures', () => {
  const captured: HeaderRule = {
    sourceRegex: '^/docs/(.*)$',
    has: [{ type: 'header', key: 'x-policy' }],
    headers: { $1: POLICY },
    documentRecoverySources: { $1: RECOVERY_SOURCE },
  };

  it('permits the resolved enforcing policy in both document judgement APIs only', () => {
    const manifest = parseProjectManifest(serializeManifest(manifestFor([captured])));
    const url = new URL('https://app.example/docs/content-security-policy');
    const headers = new Headers({ 'x-policy': '1' });

    expect(requestHeaderRulesFor(manifest, url, headers)).toStrictEqual({
      response: { headers: { 'content-security-policy': POLICY }, conditioned: true },
      document: { headers: { 'content-security-policy': PERMITTED_POLICY }, conditioned: true },
    });
    expect(documentHeaderRulesFor(manifest, url, headers).headers).toStrictEqual({
      'content-security-policy': PERMITTED_POLICY,
    });
    expect(headerRulesFor(manifest, url, headers).headers).toStrictEqual({
      'content-security-policy': POLICY,
    });
  });

  it.each(['x-policy', 'content-security-policy-report-only'])(
    'keeps the ordinary value when the capture names %s',
    (name) => {
      const manifest = manifestFor([captured]);
      const url = new URL(`https://app.example/docs/${name}`);
      const both = requestHeaderRulesFor(manifest, url, new Headers({ 'x-policy': '1' }));

      expect(both.document).toStrictEqual(both.response);
      expect(both.document.headers[name]).toBe(POLICY);
    },
  );

  it('does not apply a captured policy whose request condition is absent', () => {
    const url = new URL('https://app.example/docs/content-security-policy');

    expect(requestHeaderRulesFor(manifestFor([captured]), url, new Headers())).toStrictEqual({
      response: { headers: {}, conditioned: false },
      document: { headers: {}, conditioned: false },
    });
  });

  it.each(['$1', 'content-security-policy'])(
    'widens a captured policy value after interpolating the raw name %s',
    (name) => {
      const manifest = manifestFor([
        {
          sourceRegex: '^/docs/(content-security-policy)/(script-src)$',
          headers: { [name]: '$2' },
          documentRecoverySources: { [name]: RECOVERY_SOURCE },
        },
      ]);
      const url = new URL('https://app.example/docs/content-security-policy/script-src');

      expect(requestHeaderRulesFor(manifest, url, new Headers()).document.headers).toStrictEqual({
        'content-security-policy': `script-src ${RECOVERY_SOURCE}`,
      });
    },
  );

  it('keeps an arbitrary captured document override that is not an enforcing policy', () => {
    const manifest = manifestFor([
      {
        sourceRegex: '^/docs/(.*)$',
        headers: { 'X-$1': 'response-$1' },
        documentHeaders: { 'Y-$1': 'document-$1' },
        documentRecoverySources: { 'Y-$1': RECOVERY_SOURCE },
      },
    ]);

    expect(
      requestHeaderRulesFor(manifest, new URL('https://app.example/docs/hello'), new Headers()),
    ).toStrictEqual({
      response: { headers: { 'x-hello': 'response-hello' }, conditioned: false },
      document: { headers: { 'y-hello': 'document-hello' }, conditioned: false },
    });
  });

  it('applies recovery sources to folded document rules without changing an unlisted policy', () => {
    const manifest = {
      ...manifestFor(),
      foldedHeaderRules: [
        {
          sourceRegex: captured.sourceRegex,
          headers: captured.headers,
          documentRecoverySources: captured.documentRecoverySources,
        },
      ],
    };

    expect(foldedHeadersFor(manifest, '/docs/content-security-policy')).toStrictEqual({
      'content-security-policy': PERMITTED_POLICY,
    });
    expect(foldedHeadersFor(manifest, '/docs/x-policy')).toStrictEqual({ 'x-policy': POLICY });
  });
});
