import { policyFromBuild, type PackBodyDigests } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

/* eslint import-x/no-relative-packages: "off" -- Exercise the actual projection guard and its input type without a cyclic dependency. */
import type { PackHeaderFields } from '../../cache/src/scope/pack-header-fields.ts';
import {
  staticPageHeadersOf,
  staticPagePrivacyOf,
} from '../../cache/src/scope/static-page-privacy.ts';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('The fixture is missing a required value');
  return value;
}

const DIGEST = 'a'.repeat(64);
const BYTES = 100;
const DIGESTS: PackBodyDigests = {
  htmlSha256: DIGEST,
  htmlLength: BYTES,
  postponedSha256: null,
  postponedLength: 0,
};

function fields(): PackHeaderFields {
  return {
    scopeId: 'scope',
    entry: { entryId: 'entry', kind: 'pages', route: '/something', pathname: '/something' },
    generation: {
      generationId: 'build',
      seq: 1,
      source: 'build',
      cacheTimestamp: 1,
      producedAt: 1,
      policy: policyFromBuild({ initialRevalidate: false }),
      status: 200,
      headers: {},
      tags: [],
    },
    outputs: [
      {
        outputId: 'html',
        representationKey: 'html',
        pathname: '/something',
        status: 200,
        headers: {},
        compute: 'static',
        response: 'complete',
        staticPagePrivacy: 1,
        htmlSize: null,
        artifacts: [
          {
            artifactId: 'body',
            sha256: DIGEST,
            byteLength: BYTES,
            contentType: 'text/html; charset=utf-8',
            encoding: 'identity',
            role: 'html',
            storageRef: 'body',
          },
        ],
      },
    ],
  };
}

function document(input: PackHeaderFields) {
  const output = input.outputs[0];
  if (output === undefined) throw new Error('The fixture has no document');
  return output;
}

type Change = (input: PackHeaderFields) => PackHeaderFields;

describe('a static Pages pack carries only the build output sharing proof', () => {
  it('projects the explicit primary HTML proof without a storage read', () => {
    expect(staticPagePrivacyOf(fields(), DIGESTS)).toBe(1);
  });

  it.each<{ name: string; change: Change }>([
    { name: 'empty scope', change: (input) => ({ ...input, scopeId: '' }) },
    {
      name: 'empty entry',
      change: (input) => ({ ...input, entry: { ...input.entry, entryId: '' } }),
    },
    {
      name: 'unknown route',
      change: (input) => ({ ...input, entry: { ...input.entry, route: null } }),
    },
    {
      name: 'different route',
      change: (input) => ({ ...input, entry: { ...input.entry, route: '/other' } }),
    },
    {
      name: 'App page',
      change: (input) => ({ ...input, entry: { ...input.entry, kind: 'app-page' } }),
    },
    {
      name: 'runtime generation',
      change: (input) => ({ ...input, generation: { ...input.generation, source: 'runtime' } }),
    },
    {
      name: 'later sequence',
      change: (input) => ({ ...input, generation: { ...input.generation, seq: 2 } }),
    },
    {
      name: 'server error',
      change: (input) => ({ ...input, generation: { ...input.generation, status: 500 } }),
    },
    {
      name: 'ISR lifetime',
      change: (input) => {
        return {
          ...input,
          generation: { ...input.generation, policy: policyFromBuild({ initialRevalidate: 2 }) },
        };
      },
    },
    {
      name: 'finite expiry',
      change: (input) => {
        return {
          ...input,
          generation: {
            ...input.generation,
            policy: policyFromBuild({ initialRevalidate: false, initialExpiration: 60 }),
          },
        };
      },
    },
    {
      name: 'legacy output',
      change: (input) => {
        return {
          ...input,
          outputs: [{ ...document(input), staticPagePrivacy: undefined }],
        };
      },
    },
    {
      name: 'JSON output',
      change: (input) => {
        return {
          ...input,
          outputs: [{ ...document(input), representationKey: 'pages-data' }],
        };
      },
    },
    {
      name: 'other pathname',
      change: (input) => ({ ...input, outputs: [{ ...document(input), pathname: '/other' }] }),
    },
    {
      name: 'dynamic output',
      change: (input) => ({ ...input, outputs: [{ ...document(input), compute: 'blocking' }] }),
    },
    {
      name: 'initial shell',
      change: (input) => ({ ...input, outputs: [{ ...document(input), response: 'initial' }] }),
    },
    {
      name: 'ambiguous documents',
      change: (input) => {
        return {
          ...input,
          outputs: [document(input), { ...document(input), outputId: 'other' }],
        };
      },
    },
    {
      name: 'original cookie',
      change: (input) => {
        return {
          ...input,
          outputs: [{ ...document(input), headers: { 'Set-Cookie': 'visitor=one' } }],
        };
      },
    },
    {
      name: 'original private policy',
      change: (input) => {
        return {
          ...input,
          outputs: [{ ...document(input), headers: { 'Cache-Control': 'private' } }],
        };
      },
    },
    {
      name: 'projected private policy',
      change: (input) => {
        return {
          ...input,
          generation: { ...input.generation, headers: { 'cache-control': 'private' } },
        };
      },
    },
    {
      name: 'original variation',
      change: (input) => {
        return {
          ...input,
          outputs: [{ ...document(input), headers: { Vary: ['accept-encoding', 'cookie'] } }],
        };
      },
    },
  ])('declines a copied marker on $name', ({ change }) => {
    const changed = change(fields());

    expect(staticPagePrivacyOf(changed, DIGESTS)).toBeUndefined();
  });

  it('ties authority to the exact identity-encoded body selected for the record', () => {
    const input = fields();
    const output = document(input);
    const body = required(output.artifacts[0]);

    expect([
      staticPagePrivacyOf(input, { ...DIGESTS, htmlSha256: 'b'.repeat(64) }),
      staticPagePrivacyOf(input, { ...DIGESTS, htmlLength: BYTES + 1 }),
      staticPagePrivacyOf(input, { ...DIGESTS, postponedSha256: DIGEST, postponedLength: 1 }),
      staticPagePrivacyOf(
        { ...input, outputs: [{ ...output, artifacts: [{ ...body, encoding: 'gzip' }] }] },
        DIGESTS,
      ),
      staticPagePrivacyOf(
        {
          ...input,
          outputs: [{ ...output, artifacts: [{ ...body, contentType: 'application/json' }] }],
        },
        DIGESTS,
      ),
    ]).toStrictEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it.each(['Cache-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control'])(
    'retains only the original %s transform prohibition through the projection',
    (name) => {
      const input = fields();
      const output = document(input);
      const changed = {
        ...input,
        generation: { ...input.generation, headers: { 'cache-control': 'public, max-age=3600' } },
        outputs: [{ ...output, headers: { [name]: 'public, s-maxage=600, no-transform' } }],
      };

      expect(staticPagePrivacyOf(changed, DIGESTS)).toBe(1);
      expect(staticPageHeadersOf(changed)).toStrictEqual({ 'cache-control': 'no-transform' });
    },
  );
});
