import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { headerRulesFor, requestHeaderRulesFor } from '../src/manifest/dynamic.ts';
import { buildProjectManifest } from '../src/manifest/manifest.ts';
import type { HeaderRule, ProjectManifest } from '../src/manifest/schema.ts';
import {
  budgetPatterns,
  createPatternBudget,
  type PatternBudget,
  PatternBudgetExceededError,
} from '../src/request/pattern-budget.ts';

const OBSERVED_AT = '2026-10-15T00:00:00.000Z';

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
