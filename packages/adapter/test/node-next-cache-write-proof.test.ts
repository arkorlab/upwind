import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';
import type { NodeJwtCompilerInput } from '../src/node-jwt-compiler-proof.ts';
import { nodeNextCacheWriteData } from '../src/node-next-cache-write-data.ts';
import {
  nodeNextCacheWriteMetadata,
  nodeNextCacheWriteSites,
  qualifyNodeNextCacheWrites,
  type NodeNextCacheWriteProof,
} from '../src/node-next-cache-write-proof.ts';

const FILE = '/authored/node_modules/next/dist/compiled/next-server/pages-turbo.runtime.prod.js';
const SOURCE_SHA = '6a6fb036d30a72fcd4cb10b4ffc13318f5b0df6a205fd3fa1ce97cda1717d9c1';
function input(retained: boolean, sha256 = SOURCE_SHA): NodeJwtCompilerInput {
  return {
    graph: {
      sources: new Map([[FILE, { file: FILE, sha256 }]]),
      retained: new Set(retained ? [FILE] : []),
      importers: new Map(),
      imports: new Map(),
      rendered: new Map(),
    },
  } as unknown as NodeJwtCompilerInput;
}

describe('private fixed Next cache write proof boundaries', () => {
  it('grants no write roots without a proof or any program access', () => {
    const program = new Proxy(
      {},
      {
        get: () => {
          throw new Error('unexpected program access');
        },
      },
    );

    expect(nodeNextCacheWriteSites(undefined, FILE, 'unused', program).size).toBe(0);
  });

  it.each([{}, true, { roots: new Set() }])('rejects copied proof data %#', async (value) => {
    const proof = value as NodeNextCacheWriteProof;

    expect(() => nodeNextCacheWriteSites(proof, 'unused', 'unused', {})).toThrow(
      'copied or missing proof',
    );
    await expect(nodeNextCacheWriteMetadata(proof)).rejects.toThrow('copied or missing proof');
  });

  it('leaves an unretained source inert before modes, files or route approval are used', async () => {
    await expect(qualifyNodeNextCacheWrites(input(false))).resolves.toBeUndefined();
  });

  it('rejects a changed fixed source before filesystem or route lookup', async () => {
    await expect(qualifyNodeNextCacheWrites(input(true, 'changed'))).rejects.toThrow(
      'fixed source identity',
    );
  });

  it('requires completed original SDK modes and route scope even for an otherwise matching pin', async () => {
    await expect(qualifyNodeNextCacheWrites(input(true))).rejects.toThrow('scope');
  });

  it('does not use an unchecked root-set option as closure authority', () => {
    const code = 'globalThis.cache=42;var host;host=globalThis;exports.value=host.process.version;';
    const result: unknown = Reflect.apply(dynamicNodeClosureRefusal, undefined, [
      FILE,
      code,
      undefined,
      { metadataRoots: new Set() },
    ]);

    expect(result).toBeTypeOf('string');
  });

  it('checks a copied opaque token before ordinary module code can consume it', () => {
    expect(() => {
      Reflect.apply(dynamicNodeClosureRefusal, undefined, [
        FILE,
        'exports.value=42;',
        undefined,
        { nextCacheWrite: {} },
      ]);
    }).toThrow('copied or missing proof');
  });

  it('does not promote matching authored metadata DATA into a private source proof', () => {
    const code =
      'class Cache{}const cache=new Cache();globalThis.__incrementalCache=cache;' +
      'var host;host=globalThis;exports.version=host.process.version;';
    const data = nodeNextCacheWriteData(parseAst(code));

    expect(data?.roots.size).toBe(1);
    expect(dynamicNodeClosureRefusal(FILE, code)).toBeTypeOf('string');
    expect(() => {
      Reflect.apply(dynamicNodeClosureRefusal, undefined, [
        FILE,
        code,
        undefined,
        { nextCacheWrite: data },
      ]);
    }).toThrow('copied or missing proof');
  });
});
