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

function manifestOf(dynamicRoutes: readonly DynamicRoute[]) {
  return buildProjectManifest({
    projectId: 'manifest-memory',
    runId: 'run',
    generatedAt: DATE,
    originHost: 'manifest.example',
    deployment: { assetSetHash: 'a'.repeat(64), observedAt: DATE },
    routes: [],
    app: { deploymentId: 'dpl_manifestMemory', scriptName: 'manifest-app' },
    dynamicRoutes,
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
