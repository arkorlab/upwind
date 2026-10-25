import {
  type OutputSnapshot,
  type PackBodyDigests,
  policyFromBuild,
  policyFromCacheControl,
  policyUnknown,
} from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

/* eslint import-x/no-relative-packages: "off" -- Exercise the actual snapshot and pack projection boundary through the type seam. */
import type { PackHeaderFields } from '../../cache/src/scope/pack-header-fields.ts';
import {
  runtimeStaticPageOutputsOf,
  staticPageHeadersOf,
  staticPagePrivacyOf,
} from '../../cache/src/scope/static-page-privacy.ts';

const DIGEST = 'a'.repeat(64);
const BYTES = 100;
const DIGESTS: PackBodyDigests = {
  htmlSha256: DIGEST,
  htmlLength: BYTES,
  postponedSha256: null,
  postponedLength: 0,
};

function fields(runtime = false): PackHeaderFields {
  return {
    scopeId: 'scope',
    entry: { entryId: 'entry', kind: 'pages', route: '/news', pathname: '/news' },
    generation: {
      generationId: runtime ? 'render' : 'build',
      seq: runtime ? 2 : 1,
      source: runtime ? 'runtime' : 'build',
      cacheTimestamp: 1,
      producedAt: 1,
      policy: runtime
        ? policyFromCacheControl({ revalidate: 2, expire: 60 })
        : policyFromBuild({ initialRevalidate: 2 }),
      status: 200,
      headers: {},
      tags: [],
    },
    outputs: [
      {
        outputId: 'document',
        representationKey: 'html',
        pathname: '/news',
        status: 200,
        headers: {},
        compute: 'static',
        response: 'complete',
        staticPagePrivacy: 2,
        htmlSize: BYTES,
        artifacts: [
          {
            artifactId: 'body',
            role: 'html',
            sha256: DIGEST,
            byteLength: BYTES,
            contentType: 'text/html',
            encoding: 'identity',
            storageRef: 'body',
          },
        ],
      },
    ],
  };
}

function document(input: PackHeaderFields): OutputSnapshot {
  const output = input.outputs[0];
  if (output === undefined) throw new Error('Missing document fixture');
  return output;
}

function withDocument(input: PackHeaderFields, changes: Partial<OutputSnapshot>): PackHeaderFields {
  return { ...input, outputs: [{ ...document(input), ...changes }] };
}

function projected(input: PackHeaderFields) {
  return { ...input, outputs: runtimeStaticPageOutputsOf(input) };
}

describe('each ISR generation earns its own output authority', () => {
  type Change = (input: PackHeaderFields) => PackHeaderFields;

  it.each([false, true])('projects an independently proved runtime=%s output', (runtime) => {
    const input = fields(runtime);

    expect(staticPagePrivacyOf(input, DIGESTS)).toBe(2);
    expect(runtimeStaticPageOutputsOf(input)[0]?.staticPagePrivacy).toBe(runtime ? 2 : undefined);
  });

  it.each<Partial<PackHeaderFields['generation']>>([
    { seq: 2 },
    { source: 'runtime' },
    { policy: policyFromCacheControl({ revalidate: 2 }) },
  ])('never accepts mixed build-generation provenance %j', (changes) => {
    const input = fields();

    expect(
      staticPagePrivacyOf({ ...input, generation: { ...input.generation, ...changes } }, DIGESTS),
    ).toBeUndefined();
  });

  it('keeps an unmarked replacement private instead of inheriting previous authority', () => {
    const first = fields();
    const replacement = withDocument(fields(true), { staticPagePrivacy: undefined });

    expect(staticPagePrivacyOf(first, DIGESTS)).toBe(2);
    expect(staticPagePrivacyOf(projected(replacement), DIGESTS)).toBeUndefined();
    expect(runtimeStaticPageOutputsOf(replacement)[0]?.staticPagePrivacy).toBeUndefined();
  });

  it('removes a secondary data claim while retaining the independently proved primary', () => {
    const input = fields(true);
    const data: OutputSnapshot = {
      ...document(input),
      outputId: 'data',
      representationKey: 'pages-data',
      artifacts: [],
    };
    const outputs = runtimeStaticPageOutputsOf({ ...input, outputs: [...input.outputs, data] });

    expect(outputs.map((output) => output.staticPagePrivacy)).toStrictEqual([2, undefined]);
    expect(data.staticPagePrivacy).toBe(2);
  });

  it.each<{ name: string; change: Change }>([
    { name: 'missing scope', change: (input) => ({ ...input, scopeId: '' }) },
    {
      name: 'missing entry',
      change: (input) => ({ ...input, entry: { ...input.entry, entryId: '' } }),
    },
    {
      name: 'different route',
      change: (input) => ({ ...input, entry: { ...input.entry, route: '/other' } }),
    },
    {
      name: 'dynamic template',
      change: (input) => {
        return {
          ...input,
          entry: { ...input.entry, route: '/[slug]', pathname: '/[slug]' },
        };
      },
    },
    {
      name: 'App entry',
      change: (input) => ({ ...input, entry: { ...input.entry, kind: 'app-page' } }),
    },
    {
      name: 'first runtime sequence',
      change: (input) => ({ ...input, generation: { ...input.generation, seq: 1 } }),
    },
    {
      name: 'build policy on runtime source',
      change: (input) => {
        return {
          ...input,
          generation: { ...input.generation, policy: policyFromBuild({ initialRevalidate: 2 }) },
        };
      },
    },
    {
      name: 'legacy policy',
      change: (input) => {
        return {
          ...input,
          generation: { ...input.generation, policy: policyUnknown() },
        };
      },
    },
    {
      name: 'unbounded revalidation',
      change: (input) => {
        return {
          ...input,
          generation: {
            ...input.generation,
            policy: policyFromCacheControl({ revalidate: false }),
          },
        };
      },
    },
    {
      name: 'zero revalidation',
      change: (input) => {
        return {
          ...input,
          generation: { ...input.generation, policy: policyFromCacheControl({ revalidate: 0 }) },
        };
      },
    },
    {
      name: 'unknown expiry',
      change: (input) => {
        return {
          ...input,
          generation: {
            ...input.generation,
            policy: { ...input.generation.policy, expireAfter: { kind: 'unknown' } },
          },
        };
      },
    },
    {
      name: 'expiry before revalidation',
      change: (input) => {
        return {
          ...input,
          generation: {
            ...input.generation,
            policy: policyFromCacheControl({ revalidate: 2, expire: 1 }),
          },
        };
      },
    },
    {
      name: 'unknown clock',
      change: (input) => ({ ...input, generation: { ...input.generation, cacheTimestamp: null } }),
    },
    {
      name: 'original cookie',
      change: (input) => withDocument(input, { headers: { 'Set-Cookie': 'visitor=one' } }),
    },
    {
      name: 'original private',
      change: (input) => withDocument(input, { headers: { 'cache-control': 'private' } }),
    },
    {
      name: 'original nonce',
      change: (input) => {
        return withDocument(input, {
          headers: { 'content-security-policy': "script-src 'nonce-personal'" },
        });
      },
    },
    {
      name: 'projected private',
      change: (input) => {
        return {
          ...input,
          generation: { ...input.generation, headers: { 'cache-control': 'private' } },
        };
      },
    },
    { name: 'different body path', change: (input) => withDocument(input, { pathname: '/other' }) },
    { name: 'partial response', change: (input) => withDocument(input, { response: 'initial' }) },
    { name: 'dynamic response', change: (input) => withDocument(input, { compute: 'blocking' }) },
    {
      name: 'runtime build-proof claim',
      change: (input) => withDocument(input, { staticPagePrivacy: 1 }),
    },
  ])('drops $name before snapshot persistence and pack projection', ({ change }) => {
    const input = change(fields(true));

    expect(staticPagePrivacyOf(input, DIGESTS)).toBeUndefined();
    expect(
      runtimeStaticPageOutputsOf(input).map((output) => output.staticPagePrivacy),
    ).toStrictEqual([undefined]);
    expect(staticPagePrivacyOf(projected(input), DIGESTS)).toBeUndefined();
  });

  it.each<Partial<PackBodyDigests>>([
    { htmlSha256: 'b'.repeat(64) },
    { htmlLength: BYTES + 1 },
    { postponedSha256: 'b'.repeat(64), postponedLength: 1 },
  ])('checks the actually verified pack body independently %j', (changes) => {
    const input = projected(fields(true));

    expect(staticPagePrivacyOf(input, { ...DIGESTS, ...changes })).toBeUndefined();
  });

  it('retains no-transform but no application cache freshness in a proved runtime pack', () => {
    const input = withDocument(fields(true), {
      headers: { 'CDN-Cache-Control': 's-maxage=60, no-transform' },
    });

    expect(staticPagePrivacyOf(projected(input), DIGESTS)).toBe(2);
    expect(staticPageHeadersOf(input)['cache-control']).toBe('no-transform');
  });
});
