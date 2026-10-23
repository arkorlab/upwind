import {
  policyFromBuild,
  policyFromCacheControl,
  type OutputSnapshot,
} from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import type { PackHeaderFields } from '../src/scope/pack-header-fields.ts';
import {
  runtimeStaticPageOutputsOf,
  staticPagePrivacyOf,
} from '../src/scope/static-page-privacy.ts';

const HTML_DIGEST = 'a'.repeat(64);
const DATA_DIGEST = 'b'.repeat(64);
const NOW = 1_800_000_000_000;
const DIGESTS = {
  htmlSha256: HTML_DIGEST,
  htmlLength: 20,
  postponedSha256: null,
  postponedLength: 0,
};

function output(role: 'html' | 'pages-data'): OutputSnapshot {
  const html = role === 'html';
  return {
    outputId: role,
    representationKey: role,
    pathname: html ? '/fallback-true/first' : '/_next/data/build/fallback-true/first.json',
    status: 200,
    headers: { 'content-type': html ? 'text/html' : 'application/json' },
    compute: 'static',
    response: 'complete',
    staticPagePrivacy: 3,
    htmlSize: html ? 20 : null,
    artifacts: [
      {
        artifactId: role,
        sha256: html ? HTML_DIGEST : DATA_DIGEST,
        byteLength: 20,
        contentType: html ? 'text/html' : 'application/json',
        encoding: 'identity',
        role,
        storageRef: role,
      },
    ],
  };
}

function fixture(source: 'build' | 'runtime' = 'build', seq = 1): PackHeaderFields {
  return {
    scopeId: 'deployment',
    buildId: 'build',
    entry: {
      entryId: 'member',
      kind: 'pages',
      route: '/fallback-true/[slug]',
      pathname: '/fallback-true/first',
    },
    generation: {
      generationId: 'generation',
      seq,
      source,
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy:
        source === 'build'
          ? policyFromBuild({ initialRevalidate: 2, initialExpiration: 60 })
          : policyFromCacheControl({ revalidate: 2, expire: 60 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
    },
    outputs: [output('html'), output('pages-data')],
  };
}

function changedData(fields: PackHeaderFields, change: Partial<OutputSnapshot>): PackHeaderFields {
  return { ...fields, outputs: [fields.outputs[0]!, { ...fields.outputs[1]!, ...change }] };
}

describe('version-three concrete Pages generation proof', () => {
  it.each([
    ['build', 1],
    ['runtime', 1],
    ['runtime', 2],
  ] as const)('requires its own paired proof for %s sequence %s', (source, seq) => {
    const fields = fixture(source, seq);

    expect(staticPagePrivacyOf(fields, DIGESTS)).toBe(3);

    expect(runtimeStaticPageOutputsOf(fields).map((item) => item.staticPagePrivacy)).toStrictEqual(
      source === 'runtime' ? [3, 3] : [undefined, undefined],
    );
  });

  it.each([
    ['missing build identity', (fields: PackHeaderFields) => ({ ...fields, buildId: undefined })],
    ['another build', (fields: PackHeaderFields) => ({ ...fields, buildId: 'other' })],
    [
      'another route',
      (fields: PackHeaderFields) => {
        return {
          ...fields,
          entry: { ...fields.entry, route: '/other/[slug]' },
        };
      },
    ],
    [
      'class pathname',
      (fields: PackHeaderFields) => {
        return {
          ...fields,
          entry: { ...fields.entry, pathname: '/fallback-true/[slug]' },
        };
      },
    ],
    [
      'encoded pathname',
      (fields: PackHeaderFields) => {
        return {
          ...fields,
          entry: { ...fields.entry, pathname: '/fallback-true/%66irst' },
        };
      },
    ],
    [
      'other member data',
      (fields: PackHeaderFields) =>
        changedData(fields, { pathname: '/_next/data/build/fallback-true/second.json' }),
    ],
    [
      'unmarked data',
      (fields: PackHeaderFields) => changedData(fields, { staticPagePrivacy: undefined }),
    ],
    ['partial data', (fields: PackHeaderFields) => changedData(fields, { response: 'initial' })],
    ['dynamic data', (fields: PackHeaderFields) => changedData(fields, { compute: 'blocking' })],
    ['non-200 data', (fields: PackHeaderFields) => changedData(fields, { status: 404 })],
    [
      'missing data',
      (fields: PackHeaderFields) => ({ ...fields, outputs: fields.outputs.slice(0, 1) }),
    ],
    [
      'duplicate data',
      (fields: PackHeaderFields) => {
        return {
          ...fields,
          outputs: [...fields.outputs, output('pages-data')],
        };
      },
    ],
  ])('strips authority from %s before storing or projecting it', (_name, change) => {
    const fields = change(fixture('runtime'));

    expect(staticPagePrivacyOf(fields, DIGESTS)).toBeUndefined();
    expect(
      runtimeStaticPageOutputsOf(fields).every((item) => item.staticPagePrivacy === undefined),
    ).toBe(true);
  });

  it.each([
    { 'set-cookie': 'visitor=one' },
    { 'cache-control': 'private, max-age=0' },
    { 'cdn-cache-control': 'no-store' },
    { vary: 'Cookie' },
    { 'content-security-policy': "script-src 'nonce-visitor'" },
    { 'content-type': 'text/html' },
  ])('keeps every original data privacy veto: %j', (headers) => {
    const fields = changedData(fixture('runtime'), { headers });

    expect(staticPagePrivacyOf(fields, DIGESTS)).toBeUndefined();
    expect(
      runtimeStaticPageOutputsOf(fields).every((item) => item.staticPagePrivacy === undefined),
    ).toBe(true);
  });

  it.each([1, 2] as const)('does not expand version %s to dynamic member authority', (version) => {
    const fields = fixture('runtime', 2);
    const legacy = {
      ...fields,
      outputs: fields.outputs.map((item) => ({ ...item, staticPagePrivacy: version })),
    };

    expect(staticPagePrivacyOf(legacy, DIGESTS)).toBeUndefined();
  });

  it('checks actual primary bytes again when publishing the pack', () => {
    expect(staticPagePrivacyOf(fixture(), { ...DIGESTS, htmlSha256: DATA_DIGEST })).toBeUndefined();
    expect(staticPagePrivacyOf(fixture(), { ...DIGESTS, htmlLength: 19 })).toBeUndefined();
    expect(staticPagePrivacyOf(fixture(), { ...DIGESTS, htmlLength: 0 })).toBeUndefined();

    const fields = fixture();
    const data = fields.outputs[1]!;

    const emptyData = changedData(fields, {
      artifacts: data.artifacts.map((artifact) => ({ ...artifact, byteLength: 0 })),
    });

    expect(staticPagePrivacyOf(emptyData, DIGESTS)).toBeUndefined();
  });
});
