import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  MAX_PACK_BYTES,
  MAX_PACK_HEADER_BYTES,
  policyFromBuild,
  policyFromCacheControl,
} from '@stayingupwind/core/cache';
import { RSC_VARY } from '@stayingupwind/core/request';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import type { BlobStore } from '../src/scope/io.ts';
import {
  generationRecordBytes,
  headerFieldsOf,
  packMemoryOf,
  projectionMemoryOf,
  recordBytesOf,
  unwritableRecord,
} from '../src/scope/records.ts';
import { type EntryRow, generationOutputs, type GenerationRow } from '../src/scope/rows.ts';

const SCOPE_ID = 'scope';
const HTML = encodeUtf8('<p>static document</p>');
const NOW = 1_800_000_000_000;
const ENTRY: EntryRow = {
  entry_id: 'entry',
  kind: 'pages',
  route: '/something',
  pathname: '/something',
  cache_key_digest: 'digest',
  group_instance_id: null,
  key_descriptor: '{}',
  handler: null,
  created_at: NOW,
  created_revision: 1,
  revision: 1,
  record_revision: 1,
  kv_revision: 0,
  current_generation_id: 'generation',
  publication: 'published',
  regeneration: 'idle',
  regeneration_attempt_id: null,
  failed_count: 0,
  next_retry_at: null,
  tombstone_revision: null,
  committed_at: NOW,
  updated_at: NOW,
  fencing_max: 0,
  seq_max: 1,
};

async function generation(marked: boolean, noTransform = false): Promise<GenerationRow> {
  return {
    generation_id: 'generation',
    entry_id: ENTRY.entry_id,
    seq: 1,
    source: 'build',
    attempt_id: null,
    cache_timestamp: NOW,
    produced_at: NOW,
    policy: JSON.stringify(policyFromBuild({ initialRevalidate: false })),
    status: 200,
    headers: JSON.stringify({ 'content-type': 'text/html', vary: RSC_VARY }),
    tags: '[]',
    dependency_coverage: 'complete',
    dependency_revision: 0,
    publication: 'published',
    published_revision: 1,
    superseded_revision: null,
    condemned: null,
    storage: 'present',
    pruned_at: null,
    body_bytes: HTML.byteLength,
    producer: null,
    outputs: JSON.stringify([
      {
        outputId: 'html',
        representationKey: 'html',
        pathname: ENTRY.pathname,
        status: 200,
        headers: noTransform ? { 'Cloudflare-CDN-Cache-Control': 'no-transform' } : {},
        compute: 'static',
        response: 'complete',
        ...(marked && { staticPagePrivacy: 1 }),
        htmlSize: HTML.byteLength,
        artifacts: [
          {
            artifactId: 'html',
            role: 'html',
            sha256: await sha256Hex(HTML),
            byteLength: HTML.byteLength,
            contentType: 'text/html',
            encoding: 'identity',
            storageRef: 'html',
          },
        ],
      },
    ]),
    committed_at: NOW,
  };
}

const BLOBS: BlobStore = {
  read: (key) => Promise.resolve(key === 'html' ? HTML : undefined),
  exists: () => Promise.resolve(false),
  write: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  deletePrefix: () => Promise.resolve(),
  listPage: () => Promise.resolve({ objects: [], cursor: undefined }),
};

function paddingLimit(current: GenerationRow): number {
  const fields = headerFieldsOf({ scopeId: SCOPE_ID }, ENTRY, current, generationOutputs(current));
  let accepted = 0;
  let refused = MAX_PACK_HEADER_BYTES;
  while (refused - accepted > 1) {
    const middle = Math.floor((accepted + refused) / 2);
    const storageRef = 'x'.repeat(middle);
    const candidate = {
      ...fields,
      outputs: fields.outputs.map((output) => {
        return {
          ...output,
          artifacts: output.artifacts.map((artifact) => ({ ...artifact, storageRef })),
        };
      }),
    };
    if (unwritableRecord(candidate, MAX_PACK_BYTES) === undefined) accepted = middle;
    else refused = middle;
  }
  return accepted;
}

function decodedHeader(bytes: Uint8Array) {
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('The generated pack did not decode');
  return decoded.pack.header;
}

describe('static Pages estimates retain the projected header shape', () => {
  it.each([false, true])(
    'measures the independently proved ISR runtime=%s pack',
    async (runtime) => {
      const seeded = await generation(true, true);
      const current: GenerationRow = {
        ...seeded,
        seq: runtime ? 2 : 1,
        source: runtime ? 'runtime' : 'build',
        policy: JSON.stringify(
          runtime
            ? policyFromCacheControl({ revalidate: 2, expire: 60 })
            : policyFromBuild({ initialRevalidate: 2 }),
        ),
        outputs: JSON.stringify(
          generationOutputs(seeded).map((output) => ({ ...output, staticPagePrivacy: 2 })),
        ),
      };
      const bytes = await generationRecordBytes(
        { scopeId: SCOPE_ID, blobs: BLOBS },
        ENTRY,
        current,
      );
      const header = decodedHeader(bytes);

      expect({
        estimated: recordBytesOf(SCOPE_ID, ENTRY, current),
        reserved: projectionMemoryOf(SCOPE_ID, ENTRY, current),
        marker: header.staticPagePrivacy,
        cacheControl: header.headers['cache-control'],
      }).toStrictEqual({
        estimated: bytes.byteLength,
        reserved: packMemoryOf(bytes.byteLength),
        marker: 2,
        cacheControl: 'no-transform',
      });
    },
  );

  it.each([
    { marked: true, noTransform: false },
    { marked: true, noTransform: true },
    { marked: false, noTransform: false },
    { marked: false, noTransform: true },
  ])('measures the actual pack for $marked authority and $noTransform veto', async (options) => {
    const current = await generation(options.marked, options.noTransform);
    const bytes = await generationRecordBytes({ scopeId: SCOPE_ID, blobs: BLOBS }, ENTRY, current);
    const header = decodedHeader(bytes);

    expect({
      estimated: recordBytesOf(SCOPE_ID, ENTRY, current),
      reserved: projectionMemoryOf(SCOPE_ID, ENTRY, current),
      marker: header.staticPagePrivacy,
      cacheControl: header.headers['cache-control'],
    }).toStrictEqual({
      estimated: bytes.byteLength,
      reserved: packMemoryOf(bytes.byteLength),
      marker: options.marked ? 1 : undefined,
      cacheControl: options.marked && options.noTransform ? 'no-transform' : undefined,
    });
  });

  it('counts the sharing marker when bounding the widest header', async () => {
    const marked = await generation(true);
    const legacy = await generation(false);
    const markerBytes = encodeUtf8(',"staticPagePrivacy":1').byteLength;

    expect(paddingLimit(marked)).toBe(paddingLimit(legacy) - markerBytes);
  });
});
