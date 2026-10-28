import { describe, expect, it } from 'vitest';

import type { NodeJwtCompilerInput } from '../src/node-jwt-compiler-proof.ts';
import type { ManifestModuleGraph } from '../src/node-manifest-graph.ts';
import {
  nodeNextHookAliasData,
  nodeNextRequireHookGuardRecord,
  nodeNextRequireHookInspection,
  nodeNextRequireHookMetadata,
  nodeNextRequireHookSites,
  qualifyNodeNextRequireHook,
  type NodeNextRequireHookProof,
} from '../src/node-next-require-hook-proof.ts';

const FILE = '/authored/unavailable/node_modules/next/dist/server/require-hook.js';
const SHA256 = 'e82f0ceba88d025c725ea3062974ad9d7a54a892df8c34a525cb129202387db8';
function graph(retained: boolean, sha256 = SHA256): ManifestModuleGraph {
  return {
    sources: new Map([[FILE, { file: FILE, sha256 }]]),
    importers: new Map(),
    imports: new Map(),
    retained: new Set(retained ? [FILE] : []),
    rendered: new Map(),
  };
}
function authoredResolver(failure?: (specifier: string, attempt: number) => boolean) {
  const calls: string[] = [];
  const values = new Map([
    ['/authored/styled-jsx', '/authored/styled-jsx/index.js'],
    ['/authored/styled-jsx/style.js', '/authored/styled-jsx/style.js'],
    ['styled-jsx/package.json', '/authored/styled-jsx/package.json'],
    ['styled-jsx/style', '/authored/styled-jsx/style.js'],
  ]);
  function resolve(specifier: string) {
    calls.push(specifier);
    if (failure?.(specifier, calls.length) === true) throw new Error('authored resolution failure');
    const value = values.get(specifier);
    if (value === undefined) throw new Error('unknown authored specifier');
    return value;
  }
  return { calls, resolve };
}

describe('default Next hook alias selection DATA', () => {
  it('reproduces both stages without resolving or evaluating any real package', () => {
    const own = authoredResolver();
    const data = nodeNextHookAliasData(own.resolve);

    expect(data.qualification).toBe('UNQUALIFIED DATA');
    expect(data.aliases).toStrictEqual([
      { request: 'styled-jsx', target: '/authored/styled-jsx/index.js' },
      { request: 'styled-jsx/style', target: '/authored/styled-jsx/style.js' },
      { request: 'styled-jsx/style.js', target: '/authored/styled-jsx/style.js' },
    ]);
    expect(own.calls).toStrictEqual([
      'styled-jsx/package.json',
      'styled-jsx/style',
      'styled-jsx/style',
      '/authored/styled-jsx',
      '/authored/styled-jsx/style.js',
      '/authored/styled-jsx/style.js',
    ]);
  });

  it.each([1, 2, 3])('makes first-stage resolution failure %i atomic', (attempt) => {
    const own = authoredResolver((_specifier, at) => at === attempt);

    expect(nodeNextHookAliasData(own.resolve).aliases).toStrictEqual([]);
    expect(own.calls).toHaveLength(attempt);
  });

  it.each([4, 5, 6])('catches only one second-stage entry on failure %i', (attempt) => {
    const own = authoredResolver((_specifier, at) => at === attempt);
    const data = nodeNextHookAliasData(own.resolve);

    expect(data.aliases).toHaveLength(2);
    expect(own.calls).toHaveLength(6);
    expect(
      data.aliases.some(
        (alias) =>
          alias.request === ['styled-jsx', 'styled-jsx/style', 'styled-jsx/style.js'][attempt - 4],
      ),
    ).toBe(false);
  });
});

describe('private fixed source proof boundaries', () => {
  it('does not replace ordinary inspection without a private hook proof', () => {
    const authored = 'const mod=require("module");mod._load("unknown");';

    expect(nodeNextRequireHookInspection(undefined, FILE, authored)).toBeUndefined();
  });

  it('does not authorize sites without a proof', () => {
    const sites = nodeNextRequireHookSites(undefined, 'unused', 'unused', {});

    expect(sites.operations.size).toBe(0);
    expect(sites.namespaceOperands.size).toBe(0);
  });

  it('rejects copied proof handles before sites, files or guard records are used', async () => {
    const forged = {} as NodeNextRequireHookProof;
    let called = false;

    expect(() => nodeNextRequireHookSites(forged, 'unused', 'unused', {})).toThrow(
      'copied or missing proof',
    );
    expect(() => nodeNextRequireHookInspection(forged, FILE, 'authored')).toThrow(
      'copied or missing proof',
    );
    await expect(nodeNextRequireHookMetadata(forged)).rejects.toThrow('copied or missing proof');
    await expect(
      nodeNextRequireHookGuardRecord(forged, () => {
        called = true;
        return 'unused';
      }),
    ).rejects.toThrow('copied or missing proof');
    expect(called).toBe(false);
  });

  it('leaves an unretained file outside qualification before modes or resolution', async () => {
    await expect(
      qualifyNodeNextRequireHook({ graph: graph(false) } as NodeJwtCompilerInput),
    ).resolves.toBeUndefined();
  });

  it('rejects a changed candidate pin before any filesystem or package resolution', async () => {
    await expect(
      qualifyNodeNextRequireHook({ graph: graph(true, 'unqualified') } as NodeJwtCompilerInput),
    ).rejects.toThrow('fixed source identity');
  });

  it('does not fabricate a route/mode approval for an otherwise matching candidate', async () => {
    await expect(
      qualifyNodeNextRequireHook({ graph: graph(true) } as NodeJwtCompilerInput),
    ).rejects.toThrow('copied or missing scope');
  });
});
