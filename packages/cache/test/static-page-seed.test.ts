import { sha256Hex } from '@stayingupwind/core/artifact';
import { decodeGenerationPack } from '@stayingupwind/core/cache';
import { RSC_VARY } from '@stayingupwind/core/request';
import { createId, encodeUtf8 } from '@stayingupwind/core/util';
import { seedRouteFor } from '@stayingupwind/host/bundle';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/* eslint import-x/no-relative-packages: "off" -- Verify the actual deploy identity and share data fixtures without a cyclic dependency. */
import { staticPagesOf } from '../../deploy/src/static-pages.ts';
import { STATIC_PAGE, staticPageBundle } from '../../host/test/static-page-fixture.ts';
import { limitsOf, parseVars } from '../src/env.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import type { BlobStore } from '../src/scope/io.ts';
import { generationRecordBytes } from '../src/scope/records.ts';
import { type EntryRow, generationOutputs, type GenerationRow } from '../src/scope/rows.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope, planSeedEntries } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
const HTML = encodeUtf8('<p>hello: world</p>');

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('The fixture is missing a required value');
  return value;
}

function blobsAt(storageRef: string): BlobStore {
  return {
    read: (key) => Promise.resolve(key === storageRef ? HTML : undefined),
    exists: () => Promise.resolve(false),
    write: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    deletePrefix: () => Promise.resolve(),
    listPage: () => Promise.resolve({ objects: [], cursor: undefined }),
  };
}

describe('static Pages proof through the actual seed and record projection', () => {
  it.each([true, false])(
    'preserves explicit build authority when enabled is %s',
    async (enabled) => {
      const scopeId = createId('dpl');
      const prerender = {
        ...STATIC_PAGE,
        initialHeaders: {
          ...STATIC_PAGE.initialHeaders,
          'Cloudflare-CDN-Cache-Control': 's-maxage=600, no-transform',
        },
        body: {
          sha256: await sha256Hex(HTML),
          byteLength: HTML.byteLength,
          contentType: 'text/html; charset=utf-8',
        },
      };
      const bundle = staticPageBundle(prerender, enabled);
      const seeded = required(await seedRouteFor(bundle, prerender, { scopeId, generatedAt: NOW }));
      const input = seeded.input;
      const storageRef = required(input.generation.outputs[0]?.artifacts[0]?.storageRef);
      const mappings = await staticPagesOf(bundle, scopeId);
      const snapshot = await runInDurableObject(
        scopeStub(env, scopeId),
        async (_instance, state) => {
          const { sql } = state.storage;
          applySchema(sql, []);
          const tx = {
            sql,
            scopeId,
            now: NOW,
            revision: 1,
            limits: limitsOf(parseVars({})),
            history: NO_HISTORY,
          };
          applySeedScope(tx, {
            scope: {
              scopeId,
              organizationId: 'owner',
              projectId: 'site',
              environmentId: 'production',
              deploymentId: scopeId,
              keySchemaVersion: 1,
              buildId: bundle.buildId,
            },
          });
          const apply = await planSeedEntries(
            { ...tx, revision: 2 },
            { scopeId, batchIndex: 0, entries: [input] },
          );
          const outcome = state.storage.transactionSync(apply);
          const entry = sql.exec<EntryRow>('SELECT * FROM entries').one();
          const generation = sql.exec<GenerationRow>('SELECT * FROM generations').one();
          const bytes = await generationRecordBytes(
            { scopeId, blobs: blobsAt(storageRef) },
            entry,
            generation,
          );
          const decoded = decodeGenerationPack(bytes);
          if (decoded.kind !== 'ok') throw new Error('The projected record did not decode');
          return {
            outcome,
            stored: generationOutputs(generation)[0]?.staticPagePrivacy,
            marker: decoded.pack.header.staticPagePrivacy,
            cacheControl: decoded.pack.header.headers['cache-control'],
            vary: decoded.pack.header.headers['vary'],
            entryId: decoded.pack.header.entryId,
            scopeId: decoded.pack.header.scopeId,
            body: new TextDecoder().decode(decoded.pack.html),
          };
        },
      );

      expect(snapshot).toMatchObject({
        outcome: { inserted: 1 },
        stored: enabled ? 1 : undefined,
        marker: enabled ? 1 : undefined,
        cacheControl: enabled ? 'no-transform' : undefined,
        vary: RSC_VARY,
        scopeId,
        body: '<p>hello: world</p>',
      });
      expect(mappings.map((mapping) => mapping.entryId)).toStrictEqual(
        enabled ? [snapshot.entryId] : [],
      );
    },
  );
});
