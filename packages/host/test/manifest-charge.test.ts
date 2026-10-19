import {
  buildProjectManifest,
  type DynamicRoute,
  MAX_MANIFEST_BYTES,
  parseProjectManifest,
  serializeManifest,
} from '@stayingupwind/core/manifest';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import { EDGE_ISOLATE_BUDGET_BYTES, manifestCharge } from '../src/delivery/manifest-charge.ts';

const DATE = '2026-10-18T00:00:00.000Z';
const RULE = { sourceRegex: '^/([^/]+)$' };
const MEMBER = { route: '/[id]', kind: 'app-page' as const };
const CONDITION = { type: 'host' as const };
/** A member-heavy manifest whose stored bytes fit, while its parsed objects exceed the budget. */
const MANY_RULES = 1000;
const MANY_CONDITIONS = 600;

function manifestOf(
  dynamicRoutes: readonly DynamicRoute[],
  gateFields: {
    readonly gates?: Readonly<Record<string, string>>;
    readonly gatedPathnames?: Readonly<Record<string, string>>;
  } = {},
) {
  return buildProjectManifest({
    projectId: 'manifest-memory',
    runId: 'run',
    generatedAt: DATE,
    originHost: 'manifest.example',
    deployment: { assetSetHash: 'a'.repeat(64), observedAt: DATE },
    routes: [],
    app: { deploymentId: 'dpl_manifestMemory', scriptName: 'manifest-app' },
    dynamicRoutes,
    ...gateFields,
  });
}

describe('the memory held by a manifest’s member routes', () => {
  it.each([
    { shared: true, objects: 4 },
    { shared: false, objects: 6 },
  ])('charges condition arrays by identity, shared: $shared', ({ shared, objects }) => {
    const first = [{ type: 'host' as const }];
    const second = shared ? first : [{ type: 'host' as const }];
    const plain = manifestOf([RULE, RULE]);
    // The digest-vouched reader restores table references without a schema clone.
    const listed = {
      ...plain,
      dynamicRoutes: [
        { ...RULE, members: { ...MEMBER, bypassFor: first } },
        { ...RULE, members: { ...MEMBER, bypassFor: second } },
      ],
    };

    expect(manifestCharge(listed, 0) - manifestCharge(plain, 0)).toBe(80 * objects);
  });

  it.each<{ members?: DynamicRoute['members']; objects: number }>([
    { objects: 0 },
    { members: MEMBER, objects: 1 },
    { members: { ...MEMBER, bypassFor: [] }, objects: 2 },
    { members: { ...MEMBER, bypassFor: [CONDITION] }, objects: 3 },
    {
      members: { ...MEMBER, bypassFor: [CONDITION, CONDITION], keyedBy: ['id'] },
      objects: 5,
    },
  ])('charges member containers and conditions beside their JSON: %j', (example) => {
    const plain = manifestOf([RULE]);
    const listed = manifestOf([{ ...RULE, members: example.members }]);
    const plainBytes = encodeUtf8(serializeManifest(plain)).byteLength;
    const listedBytes = encodeUtf8(serializeManifest(listed)).byteLength;

    // The existing model charges 80 bytes per object, separately from 1.5 times stored JSON.
    expect(
      manifestCharge(listed, listedBytes) -
        manifestCharge(plain, plainBytes) -
        1.5 * (listedBytes - plainBytes),
    ).toBe(80 * example.objects);
  });

  it('keeps the existing budget effective for a schema-valid member-heavy manifest', () => {
    const manifest = manifestOf(
      Array.from({ length: MANY_RULES }, () => {
        return {
          ...RULE,
          members: {
            ...MEMBER,
            bypassFor: Array.from({ length: MANY_CONDITIONS }, () => CONDITION),
          },
        };
      }),
    );
    const serialized = serializeManifest(manifest);
    const parsed = parseProjectManifest(serialized);
    const bytes = encodeUtf8(serialized).byteLength;
    const ordinary = manifestOf([{ ...RULE, members: { ...MEMBER, bypassFor: [CONDITION] } }]);
    const ordinaryBytes = encodeUtf8(serializeManifest(ordinary)).byteLength;

    expect(bytes).toBeLessThan(MAX_MANIFEST_BYTES);
    expect(parsed.dynamicRoutes?.[0]?.members?.bypassFor).toHaveLength(MANY_CONDITIONS);
    expect(parsed.dynamicRoutes?.[0]?.members?.bypassFor).not.toBe(
      parsed.dynamicRoutes?.[1]?.members?.bypassFor,
    );
    expect(manifestCharge(parsed, bytes)).toBeGreaterThan(EDGE_ISOLATE_BUDGET_BYTES);
    expect(manifestCharge(ordinary, ordinaryBytes)).toBeLessThan(EDGE_ISOLATE_BUDGET_BYTES);
  });
});

describe('the lookup maps of captured document policies', () => {
  it.each([
    { shared: true, objects: 1 },
    { shared: false, objects: 2 },
  ])('charges physical source maps once across both rule lists: %j', ({ shared, objects }) => {
    const first = { $1: "'sha256-recovery'" };
    const second = shared ? first : { ...first };
    const plain = {
      ...manifestOf([]),
      headerRules: [{ ...RULE, headers: {} }],
      foldedHeaderRules: [{ ...RULE, headers: {} }],
    };
    const listed = {
      ...plain,
      headerRules: [{ ...RULE, headers: {}, documentRecoverySources: first }],
      foldedHeaderRules: [{ ...RULE, headers: {}, documentRecoverySources: second }],
    };

    expect(manifestCharge(listed, 0) - manifestCharge(plain, 0)).toBe(80 * objects);
  });

  it('charges policy-map strings through stored JSON and their parsed container separately', () => {
    const plain = { ...manifestOf([]), headerRules: [{ ...RULE, headers: {} }] };
    const listed = {
      ...plain,
      headerRules: [
        {
          ...RULE,
          headers: {},
          documentRecoverySources: {
            $1: "'sha256-recovery'",
            'content-security-policy': "'sha256-other'",
          },
        },
      ],
    };
    const plainStored = serializeManifest(plain);
    const stored = serializeManifest(listed);
    const parsed = parseProjectManifest(stored);

    expect(parsed.headerRules?.[0]?.documentRecoverySources).toStrictEqual(
      listed.headerRules[0]?.documentRecoverySources,
    );
    expect(
      manifestCharge(parsed, encodeUtf8(stored).byteLength) -
        manifestCharge(plain, encodeUtf8(plainStored).byteLength) -
        1.5 * (encodeUtf8(stored).byteLength - encodeUtf8(plainStored).byteLength),
    ).toBe(80);
  });
});

describe('the additional lookup tables of a gated manifest', () => {
  it.each([
    { gates: 1, pathnames: 2 },
    { gates: 2, pathnames: 3 },
  ])('charges $gates gate names and $pathnames pathname mappings after parsing', (counts) => {
    const gates = Object.fromEntries(
      Array.from({ length: counts.gates }, (_, index) => [`/gate-${index}`, 'protected']),
    );
    const gatedPathnames = Object.fromEntries(
      Array.from({ length: counts.pathnames }, (_, index) => {
        const result: readonly [string, string] = [
          `/member-${index}`,
          `/gate-${index % counts.gates}`,
        ];
        return result;
      }),
    );
    const plain = manifestOf([RULE]);
    const listed = manifestOf([RULE], { gates, gatedPathnames });
    const plainStored = serializeManifest(plain);
    const stored = serializeManifest(listed);
    const parsed = parseProjectManifest(stored);

    expect(parsed.gates).toStrictEqual(gates);
    expect(parsed.gatedPathnames).toStrictEqual(gatedPathnames);
    expect(parsed.gates).not.toBe(gates);
    expect(parsed.gatedPathnames).not.toBe(gatedPathnames);
    // Their strings pay the existing JSON multiplier; each extra table entry pays the same
    // 48 bytes already used for exactFunctions, rather than disappearing beside its pathname.
    expect(
      manifestCharge(parsed, encodeUtf8(stored).byteLength) -
        manifestCharge(plain, encodeUtf8(plainStored).byteLength) -
        1.5 * (encodeUtf8(stored).byteLength - encodeUtf8(plainStored).byteLength),
    ).toBe(48 * (counts.gates + counts.pathnames));
  });
});

describe('the request-key static file format', () => {
  it('charges its primitive mode flag through the existing stored JSON multiplier', () => {
    const plain = manifestOf([]);
    const listed = { ...plain, schemaVersion: 7 as const, staticFileRequestKeys: true as const };
    const plainStored = serializeManifest(plain);
    const stored = serializeManifest(listed);
    const parsed = parseProjectManifest(stored);
    const extraBytes = encodeUtf8(stored).byteLength - encodeUtf8(plainStored).byteLength;

    expect(parsed.staticFileRequestKeys).toBe(true);
    expect(extraBytes).toBeGreaterThan(0);
    expect(
      manifestCharge(parsed, encodeUtf8(stored).byteLength) -
        manifestCharge(plain, encodeUtf8(plainStored).byteLength),
    ).toBe(1.5 * extraBytes);
  });
});

describe('the memory held by route-body mappings', () => {
  it('charges the map, entries and bypass conditions separately from their JSON', () => {
    const plain = manifestOf([]);
    const listed = {
      ...plain,
      routeBodies: {
        '/icon': { pathname: '/icon', route: '/icon', entryId: 'icon', bypassFor: [CONDITION] },
      },
    };
    const plainBytes = encodeUtf8(serializeManifest(plain)).byteLength;
    const listedBytes = encodeUtf8(serializeManifest(listed)).byteLength;
    const objects = 4;

    expect(
      manifestCharge(listed, listedBytes) -
        manifestCharge(plain, plainBytes) -
        1.5 * (listedBytes - plainBytes),
    ).toBe(80 * objects);
  });
});
