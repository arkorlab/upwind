import type { RouteHas } from '@stayingupwind/core/bundle';
import {
  buildProjectManifest,
  headerRulesFor,
  type HeaderRule,
} from '@stayingupwind/core/manifest';
import { NAVIGATION_REQUEST_HEADERS } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { carryingEach } from '../src/escaping.ts';
import { requestsForRules } from '../src/rule-witnesses.ts';

const URL_OF_DOCUMENT = new URL('https://site.example/about');
const AT = '2026-10-21T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const MANIFEST = buildProjectManifest({
  projectId: 'site',
  runId: 'run',
  generatedAt: AT,
  originHost: URL_OF_DOCUMENT.hostname,
  deployment: { assetSetHash: SHA, observedAt: AT },
  app: { deploymentId: 'dpl_site', scriptName: 'app' },
  routes: [],
});

function ruleFor(condition: RouteHas): HeaderRule {
  return { sourceRegex: '^/about$', has: [condition], headers: { 'x-witness': 'selected' } };
}

function carried(condition: RouteHas) {
  const made = carryingEach(NAVIGATION_REQUEST_HEADERS, URL_OF_DOCUMENT, [condition]);
  if (made === undefined) throw new Error('no witness for a valid identity escape');
  return made;
}

/** Rule witness generation reads the manifest, not transport or a running Worker. */
function stackFor(rule: HeaderRule): CheckedStack {
  return { manifest: { ...MANIFEST, headerRules: [rule] } } as CheckedStack;
}

const CONDITIONS: readonly RouteHas[] = [
  { type: 'header', key: 'x-release', value: String.raw`release\-candidate` },
  { type: 'cookie', key: 'release', value: String.raw`release\-candidate` },
  { type: 'query', key: 'release', value: String.raw`release\-candidate` },
];

describe('condition witnesses preserve the shared routing contract', () => {
  it.each(CONDITIONS)('selects the actual $type rule with an identity escape', (condition) => {
    const made = carried(condition);
    const rule = ruleFor(condition);
    const selected = headerRulesFor(
      { ...MANIFEST, headerRules: [rule] },
      made.url,
      new Headers(made.headers),
    );

    expect(made.carried).toContain('release-candidate');
    expect(selected.headers['x-witness']).toBe('selected');
  });

  it.each(['Range', 'Service-Worker', 'X-Deployment-Id'])(
    'does not synthesize %s to select a different request class',
    (key) => {
      const rule = ruleFor({ type: 'header', key, value: '1' });
      const result = requestsForRules(stackFor(rule), URL_OF_DOCUMENT, NAVIGATION_REQUEST_HEADERS, [
        rule,
      ]);

      expect(result.requests).toStrictEqual([]);
      expect(result.unproved).toBeUndefined();
    },
  );

  it('still makes an applicable ordinary header rule select its own response', () => {
    const rule = ruleFor({ type: 'header', key: 'x-feature', value: '^blue$' });
    const stack = stackFor(rule);
    const result = requestsForRules(stack, URL_OF_DOCUMENT, NAVIGATION_REQUEST_HEADERS, [rule]);
    const request = result.requests[0];

    expect(result.unproved).toBeUndefined();
    expect(result.requests).toHaveLength(1);
    expect(request?.headers['x-feature']).toBe('blue');
    expect(
      headerRulesFor(stack.manifest, URL_OF_DOCUMENT, new Headers(request?.headers)).headers[
        'x-witness'
      ],
    ).toBe('selected');
  });

  it('does not try to remove the Via header routing always supplies', () => {
    const rule: HeaderRule = {
      sourceRegex: '^/about$',
      missing: [{ type: 'header', key: 'via' }],
      headers: { 'x-witness': 'selected' },
    };
    const result = requestsForRules(stackFor(rule), URL_OF_DOCUMENT, NAVIGATION_REQUEST_HEADERS, [
      rule,
    ]);

    expect(result.requests).toStrictEqual([]);
    expect(result.unproved).toBeUndefined();
  });

  it('does not invent a Via value the routing view always overwrites', () => {
    const rule = ruleFor({ type: 'header', key: 'via', value: '^never$' });
    const result = requestsForRules(stackFor(rule), URL_OF_DOCUMENT, NAVIGATION_REQUEST_HEADERS, [
      rule,
    ]);

    expect(result.requests).toStrictEqual([]);
    expect(result.unproved).toBeUndefined();
  });
});
