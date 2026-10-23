import { describe, expect, it } from 'vitest';

import {
  compactPackArtifact,
  isRepairStorageRef,
  REPAIR_STORAGE_REF_LENGTH,
} from '../src/cache/artifact-locator.ts';
import { packHeaderOf } from '../src/cache/pack-header.ts';
import {
  decodeGenerationPack,
  encodeGenerationPack,
  MAX_PACK_HEADER_BYTES,
  PACK_SCHEMA_VERSION,
  packHeaderBytes,
} from '../src/cache/pack.ts';
import { type GenerationPackHeader, generationPackHeaderSchema } from '../src/cache/schema.ts';
import { policyFromBuild } from '../src/cache/timing.ts';
import { concatBytes, encodeUtf8 } from '../src/util/bytes.ts';

const ARTIFACT = {
  artifactId: 'blob_existing_scope_bound_id',
  sha256: 'b'.repeat(64),
  byteLength: 1,
  contentType: 'text/x-component',
  encoding: 'identity' as const,
  role: 'rsc' as const,
  representationKey: 'rsc',
  storageRef: 'x',
};
const HEADER: GenerationPackHeader = {
  schemaVersion: 1,
  scopeId: 'scope',
  entryId: 'entry',
  generationId: 'generation',
  seq: 1,
  source: 'build',
  kind: 'app-page',
  route: '/',
  pathname: '/',
  cacheTimestamp: 0,
  producedAt: 0,
  policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
  status: 200,
  headers: {},
  tags: [],
  htmlSha256: 'a'.repeat(64),
  htmlLength: 0,
  postponedSha256: null,
  postponedLength: 0,
  artifacts: [ARTIFACT],
  revision: 1,
};
const EMPTY = new Uint8Array(0);
const REPAIR = 'r/00000000000040008000000000000000/00000000000040008000000000000001';
const NEXT_REPAIR = 'r/00000000000040008000000000000000/00000000000040008000000000000002';

function rawPack(header: unknown, version: number): Uint8Array {
  const body = encodeUtf8(JSON.stringify(header));
  const prefix = new Uint8Array(9);
  prefix.set(encodeUtf8('PPRG'));
  prefix[4] = version;
  new DataView(prefix.buffer).setUint32(5, body.byteLength, true);
  return concatBytes([prefix, body]);
}

describe('reader-first fixed-width repair locators', () => {
  it('keeps the default producer and retained literal records at version one', () => {
    expect(PACK_SCHEMA_VERSION).toBe(1);
    const encoded = encodeGenerationPack(HEADER, EMPTY, undefined);
    expect(encoded).toStrictEqual(rawPack(HEADER, 1));
    expect(decodeGenerationPack(encoded)).toMatchObject({ kind: 'ok', pack: { header: HEADER } });
  });

  it('expands a version-two repair tuple to the existing artifact values', () => {
    const artifact = { ...ARTIFACT, storageRef: REPAIR };
    const header = { ...HEADER, schemaVersion: 2 as const, artifacts: [artifact] };
    const wire = { ...header, artifacts: [compactPackArtifact(artifact)] };
    const decoded = decodeGenerationPack(rawPack(wire, 2));
    expect(decoded).toMatchObject({ kind: 'ok', pack: { header } });
    expect(packHeaderOf(wire)).toStrictEqual(generationPackHeaderSchema.parse(header));
    expect(encodeGenerationPack(header, EMPTY, undefined)).toStrictEqual(rawPack(wire, 2));
    expect(REPAIR).toHaveLength(REPAIR_STORAGE_REF_LENGTH);
  });

  it('keeps short literals and absent locations as ordinary objects in the new format', () => {
    const withoutLocation = { ...ARTIFACT };
    Reflect.deleteProperty(withoutLocation, 'storageRef');
    const header = { ...HEADER, schemaVersion: 2 as const, artifacts: [ARTIFACT, withoutLocation] };
    expect(encodeGenerationPack(header, EMPTY, undefined)).toStrictEqual(rawPack(header, 2));
    expect(decodeGenerationPack(rawPack(header, 2))).toMatchObject({
      kind: 'ok',
      pack: { header },
    });
  });

  it.each(['x', 'repair/short', 'repair/00000000-0000-4000-8000-00000000000x', '', null, 0])(
    'rejects a malformed or variable-width repair tuple location %j',
    (storageRef) => {
      const tuple = [
        ARTIFACT.artifactId,
        ARTIFACT.sha256,
        ARTIFACT.byteLength,
        ARTIFACT.contentType,
        ARTIFACT.encoding,
        ARTIFACT.role,
        storageRef,
        ARTIFACT.representationKey,
      ];
      const header = { ...HEADER, schemaVersion: 2, artifacts: [tuple] };
      expect(isRepairStorageRef(storageRef)).toBe(false);
      expect(packHeaderOf(header)).toBeUndefined();
      expect(decodeGenerationPack(rawPack(header, 2)).kind).toBe('corrupt');
    },
  );

  it('never treats a tuple as a version-one artifact', () => {
    const header = {
      ...HEADER,
      artifacts: [compactPackArtifact({ ...ARTIFACT, storageRef: REPAIR })],
    };
    expect(packHeaderOf(header)).toBeUndefined();
    expect(decodeGenerationPack(rawPack(header, 1)).kind).toBe('corrupt');
  });

  it('requires the prefix and header to agree and still rejects future versions', () => {
    expect(decodeGenerationPack(rawPack(HEADER, 2))).toMatchObject({
      kind: 'corrupt',
      reason: 'prefix and header versions differ',
    });
    expect(decodeGenerationPack(rawPack(HEADER, 3))).toStrictEqual({
      kind: 'unsupported',
      version: 3,
    });
  });

  it('repairs a shortest literal at the existing header ceiling and stays equal on another repair', () => {
    const withPadding = { ...HEADER, scopeId: 's'.repeat(2000), headers: { padding: '' } };
    const padding = 'p'.repeat(MAX_PACK_HEADER_BYTES - packHeaderBytes(withPadding));
    const previous = { ...withPadding, headers: { padding } };
    expect(packHeaderBytes(previous)).toBe(MAX_PACK_HEADER_BYTES);
    const repaired = {
      ...previous,
      schemaVersion: 2 as const,
      artifacts: [{ ...ARTIFACT, storageRef: REPAIR }],
    };
    expect(packHeaderBytes(repaired)).toBe(MAX_PACK_HEADER_BYTES - 34);
    const bytes = encodeGenerationPack(repaired, EMPTY, undefined);
    expect(decodeGenerationPack(bytes)).toMatchObject({ kind: 'ok', pack: { header: repaired } });
    const repairedAgain = { ...repaired, artifacts: [{ ...ARTIFACT, storageRef: NEXT_REPAIR }] };
    expect(packHeaderBytes(repairedAgain)).toBe(packHeaderBytes(repaired));
  });
});
