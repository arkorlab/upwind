import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { assertNodeProofFiles } from '../src/node-proof.ts';
import { assertRawNodeSource } from '../src/node-source-runtime.ts';

function source(file: string, code: string) {
  const bytes = new TextEncoder().encode(code);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { original: { file, sha256 }, copied: { name: file, bytes } };
}

describe('unchanged executable sources in a native Node artifact', () => {
  it('still verifies copied bytes when the source was also bundled into instrumentation', () => {
    const own = source('/project/shared.js', 'module.exports = 1;');
    const physical = {
      files: [{ ...own.copied, bytes: new TextEncoder().encode('module.exports = 2;') }],
      sourcePaths: new Map([[own.copied.name, own.original.file]]),
      nameOf: (file: string) => file,
    };

    expect(() => {
      assertNodeProofFiles(
        { files: [own.original], native: [] },
        physical,
        new Map([[own.original.file, own.original.sha256]]),
      );
    }).toThrow('absent or changed');
  });

  it.each(['.ts', '.cts', '.mts'])(
    'accepts erasable %s annotations without changing archived bytes',
    (extension) => {
      const own = source(`/project/source${extension}`, 'const value: number = 42;');
      const before = new Uint8Array(own.copied.bytes);

      expect(() => {
        assertRawNodeSource(own.original.file, own.copied.bytes);
      }).not.toThrow();
      expect(own.copied.bytes).toStrictEqual(before);
    },
  );

  it.each([
    ['.ts', 'enum Value { First = 1 }'],
    ['.cts', 'class Value { constructor(public field: number) {} }'],
    ['.tsx', 'export const element = <div />;'],
    ['.jsx', 'module.exports = <div />;'],
  ])('refuses raw %s syntax that requires a runtime compiler', (extension, code) => {
    const own = source(`/project/source${extension}`, code);
    const physical = {
      files: [own.copied],
      sourcePaths: new Map([[own.copied.name, own.original.file]]),
      nameOf: (file: string) => file,
    };
    const proof = { files: [own.original], native: [] };

    expect(() => {
      assertNodeProofFiles(proof, physical, new Map());
    }).toThrow('compilation before native publication');
  });

  it('keeps separately compiled instrumentation under its original byte and output proof', () => {
    const own = source('/project/instrumentation.ts', 'enum Hook { Start = 1 }');
    const proof = { files: [own.original], native: [] };
    const compiled = new Map([[own.original.file, own.original.sha256]]);

    expect(() => {
      assertNodeProofFiles(
        proof,
        { files: [], sourcePaths: new Map(), nameOf: (file) => file },
        compiled,
      );
    }).not.toThrow();
  });

  it('does not let a compiled hook exempt its simultaneously shipped raw dependency', () => {
    const own = source('/project/hook.ts', 'enum Hook { Start = 1 }');
    const proof = { files: [own.original], native: [] };
    const physical = {
      files: [own.copied],
      sourcePaths: new Map([[own.copied.name, own.original.file]]),
      nameOf: (file: string) => file,
    };

    expect(() => {
      assertNodeProofFiles(proof, physical, new Map([[own.original.file, own.original.sha256]]));
    }).toThrow('compilation before native publication');
  });

  it.each(['.ts', '.cts', '.mts'])(
    'checks Node module type-stripping policy at the actual archived %s path',
    (extension) => {
      const own = source(`/build/hook${extension}`, 'const value: number = 1;');
      const name = `project/node_modules/package/hook${extension}`;
      const physical = {
        files: [{ ...own.copied, name }],
        sourcePaths: new Map([[name, own.original.file]]),
        nameOf: () => name,
      };

      expect(() => {
        assertNodeProofFiles({ files: [own.original], native: [] }, physical, new Map());
      }).toThrow('node_modules requires compilation');
    },
  );
});
