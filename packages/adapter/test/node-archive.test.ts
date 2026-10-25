import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { nodeArtifactArchive } from '../src/node-archive.ts';

interface TarFile {
  readonly name: string;
  readonly mode: number;
  readonly owner: readonly number[];
  readonly timestamp: number;
  readonly type: string;
  readonly link: string;
  readonly bytes: Buffer;
  readonly validChecksum: boolean;
}

function stringOf(header: Buffer, start: number, length: number): string {
  return (
    header
      .subarray(start, start + length)
      .toString()
      .split('\0')[0] ?? ''
  );
}

function numberOf(header: Buffer, start: number, length: number): number {
  return Number.parseInt(stringOf(header, start, length), 8);
}

function filesOf(archive: Uint8Array): TarFile[] {
  const tar = gunzipSync(archive);
  const files: TarFile[] = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = numberOf(header, 124, 12);
    const prefix = stringOf(header, 345, 155);
    const name = stringOf(header, 0, 100);
    const recorded = numberOf(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    files.push({
      name: prefix === '' ? name : `${prefix}/${name}`,
      mode: numberOf(header, 100, 8),
      owner: [numberOf(header, 108, 8), numberOf(header, 116, 8)],
      timestamp: numberOf(header, 136, 12),
      type: stringOf(header, 156, 1),
      link: stringOf(header, 157, 100),
      bytes: tar.subarray(offset + 512, offset + 512 + size),
      validChecksum: checksumHeader.reduce((sum, byte) => sum + byte, 0) === recorded,
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe('canonical Node Function archive', () => {
  it('orders distinct Unicode spellings by code units even when locale collation treats them as equal', () => {
    const input = [
      { name: 'project/caf\u00e9.txt', bytes: new Uint8Array([1]) },
      { name: 'project/cafe\u0301.txt', bytes: new Uint8Array([2]) },
    ];
    const archive = nodeArtifactArchive(input);

    expect(archive).toStrictEqual(nodeArtifactArchive(input.toReversed()));
    expect(filesOf(archive).map(({ name }) => name)).toStrictEqual([
      'project/cafe\u0301.txt',
      'project/caf\u00e9.txt',
    ]);
  });

  it('is input-order independent and preserves regular bytes with fixed ownership/time and explicit executable mode', () => {
    const input = [
      { name: 'project/native/addon.node', bytes: new Uint8Array([0, 1, 255]) },
      {
        name: 'upwind/server.mjs',
        bytes: new TextEncoder().encode('export {};\n'),
        executable: true,
      },
    ];
    const archive = nodeArtifactArchive(input);
    const files = filesOf(archive);

    expect(archive).toStrictEqual(nodeArtifactArchive(input.toReversed()));
    expect(files).toStrictEqual([
      {
        name: 'project/native/addon.node',
        mode: 0o644,
        owner: [0, 0],
        timestamp: 0,
        type: '0',
        link: '',
        bytes: Buffer.from([0, 1, 255]),
        validChecksum: true,
      },
      {
        name: 'upwind/server.mjs',
        mode: 0o755,
        owner: [0, 0],
        timestamp: 0,
        type: '0',
        link: '',
        bytes: Buffer.from('export {};\n'),
        validChecksum: true,
      },
    ]);
  });

  it('uses the USTAR prefix/name split for a portable 240-character path', () => {
    const name = `${'p'.repeat(139)}/${'n'.repeat(100)}`;
    const files = filesOf(nodeArtifactArchive([{ name, bytes: new Uint8Array([7]) }]));

    expect(
      files.map((file) => ({
        name: file.name,
        bytes: [...file.bytes],
        validChecksum: file.validChecksum,
      })),
    ).toStrictEqual([{ name, bytes: [7], validChecksum: true }]);
  });

  it.each([
    '/absolute',
    '../parent',
    'a/../parent',
    'a/./same',
    'a//empty',
    'a\\backslash',
    'a:drive',
    'a\0nul',
    'a\nline',
    'x'.repeat(241),
  ])('rejects nonportable member %j', (name) => {
    expect(() => nodeArtifactArchive([{ name, bytes: new Uint8Array() }])).toThrow(Error);
  });

  it.each([
    ['same', 'same'],
    ['file', 'file/child'],
    ['file/child', 'file'],
  ])('rejects duplicate paths and file/directory conflicts %j', (left, right) => {
    expect(() =>
      nodeArtifactArchive([
        { name: left, bytes: new Uint8Array() },
        { name: right, bytes: new Uint8Array() },
      ]),
    ).toThrow(Error);
  });

  it('rejects a long unsplittable component and the file-count limit before constructing an archive', () => {
    const member = { name: 'one', bytes: new Uint8Array() };

    expect(() => nodeArtifactArchive([{ ...member, name: 'x'.repeat(101) }])).toThrow(Error);
    expect(() => nodeArtifactArchive(Array.from({ length: 100_001 }, () => member))).toThrow(Error);
  });
});
