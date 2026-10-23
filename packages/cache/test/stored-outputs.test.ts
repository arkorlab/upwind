import { type OutputSnapshot } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import { decodeStoredOutputs, encodeStoredOutputs } from '../src/scope/stored-outputs.ts';

const OUTPUT: OutputSnapshot = {
  outputId: 'output',
  representationKey: 'rsc',
  pathname: '/',
  status: 200,
  headers: {},
  compute: 'static',
  response: 'complete',
  htmlSize: null,
  artifacts: [
    {
      artifactId: 'blob_existing_identity',
      sha256: 'a'.repeat(64),
      byteLength: 1,
      contentType: 'text/x-component',
      encoding: 'identity',
      role: 'rsc',
      storageRef: 'x',
    },
  ],
};

const REPAIR = 'repair/00000000-0000-4000-8000-000000000001';
const NEXT_REPAIR = 'repair/00000000-0000-4000-8000-000000000002';

function withStorageRef(storageRef: string): OutputSnapshot[] {
  return [
    { ...OUTPUT, artifacts: OUTPUT.artifacts.map((artifact) => ({ ...artifact, storageRef })) },
  ];
}

describe('stored output reader compatibility', () => {
  it('defaults to literal writes and reads retained legacy rows without changing them', () => {
    const outputs = withStorageRef(REPAIR);
    expect(encodeStoredOutputs(outputs)).toBe(JSON.stringify(outputs));
    expect(decodeStoredOutputs(JSON.stringify(outputs))).toStrictEqual(outputs);
    expect(encodeStoredOutputs([OUTPUT], true)).toBe(JSON.stringify([OUTPUT]));
  });

  it('keeps repaired rows smaller than a shortest accepted borrowed reference', () => {
    const repaired = withStorageRef(REPAIR);
    const stored = encodeStoredOutputs(repaired, true);
    expect(stored.length).toBe(JSON.stringify([OUTPUT]).length - 38);
    expect(JSON.parse(stored)[0].artifacts[0]).toStrictEqual([
      OUTPUT.artifacts[0]!.artifactId,
      OUTPUT.artifacts[0]!.sha256,
      1,
      'text/x-component',
      'identity',
      'rsc',
      REPAIR,
    ]);
    expect(decodeStoredOutputs(stored)).toStrictEqual(repaired);
    expect(encodeStoredOutputs(decodeStoredOutputs(stored), true)).toBe(stored);
    expect(encodeStoredOutputs(withStorageRef(NEXT_REPAIR), true).length).toBe(stored.length);
  });

  it.each([-1, 1, 0, null, false, ''])('rejects malformed stored locator %j', (storageRef) => {
    const stored = [{ ...OUTPUT, artifacts: [{ ...OUTPUT.artifacts[0], storageRef }] }];
    expect(() => decodeStoredOutputs(JSON.stringify(stored))).toThrow();
  });

  it('rejects a short reference in a tuple instead of admitting growth on its next repair', () => {
    const artifact = OUTPUT.artifacts[0]!;
    const stored = [
      {
        ...OUTPUT,
        artifacts: [
          [
            artifact.artifactId,
            artifact.sha256,
            1,
            artifact.contentType,
            artifact.encoding,
            artifact.role,
            'x',
          ],
        ],
      },
    ];
    expect(() => decodeStoredOutputs(JSON.stringify(stored))).toThrow();
  });

  it('does not expand numbers in response headers into valid strings', () => {
    const stored = [{ ...OUTPUT, headers: { artifactId: 'header', storageRef: 0 } }];
    expect(() => decodeStoredOutputs(JSON.stringify(stored))).toThrow();
  });
});
