import { describe, expect, it } from 'vitest';

import { DATA_RECORD_SCHEMA_VERSION, dataRecordSchema } from '../src/scope/data-record.ts';

/**
 * The data-cache record as both gateways read it out of KV: what they answer a read with, and
 * what they take for no record at all.
 */

const ENTRY = {
  kind: 'data:fetch',
  tags: ['posts'],
  stale: 300,
  timestamp: 1_800_000_000_000,
  expire: 31_536_000,
  revalidate: 60,
  dependencyCoverage: 'complete',
} as const;

const INLINE = {
  schemaVersion: DATA_RECORD_SCHEMA_VERSION,
  scopeId: 'scope',
  entryId: 'entry',
  generationId: 'generation',
  revision: 3,
  dependencyRevision: 2,
  entry: ENTRY,
  value: { kind: 'inline', base64: 'aGVsbG8=' },
} as const;

const REF = {
  ...INLINE,
  value: { kind: 'ref', artifactId: 'artifact', storageRef: 'blobs/artifact', byteLength: 5 },
} as const;

describe('dataRecordSchema', () => {
  it('reads an inline value and a value stored apart', () => {
    expect(dataRecordSchema.safeParse(INLINE)).toStrictEqual({ success: true, data: INLINE });
    expect(dataRecordSchema.safeParse(REF)).toStrictEqual({ success: true, data: REF });
  });

  it('keeps an invalidation, and leaves one out where the record has none', () => {
    const invalidation = { revision: 4, staleAt: 1_800_000_000_500 };

    expect(dataRecordSchema.parse({ ...INLINE, invalidation }).invalidation).toStrictEqual(
      invalidation,
    );
    expect('invalidation' in dataRecordSchema.parse(INLINE)).toBe(false);
  });

  it('drops what it does not name', () => {
    const parsed = dataRecordSchema.parse({
      ...REF,
      unknownField: true,
      value: { ...REF.value, unknownField: true },
    });

    expect(parsed).toStrictEqual(REF);
  });

  it.each([
    ['no record at all', null],
    ['another schema version', { ...INLINE, schemaVersion: DATA_RECORD_SCHEMA_VERSION + 1 }],
    ['an empty entry id', { ...INLINE, entryId: '' }],
    ['a negative revision', { ...INLINE, revision: -1 }],
    ['a fractional revision', { ...INLINE, dependencyRevision: 1.5 }],
    ['a value of no known kind', { ...INLINE, value: { kind: 'other', base64: '' } }],
    ['a stored value of no length', { ...REF, value: { ...REF.value, byteLength: -1 } }],
    ['a stored value with no storage key', { ...REF, value: { ...REF.value, storageRef: '' } }],
    ['a fetch entry that names a handler', { ...INLINE, entry: { ...ENTRY, handler: 'default' } }],
    ['an invalidation with no revision', { ...INLINE, invalidation: { staleAt: 1 } }],
  ])('takes %s for no record', (_name, stored) => {
    expect(dataRecordSchema.safeParse(stored).success).toBe(false);
  });
});
