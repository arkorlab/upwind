import { describe, expect, it } from 'vitest';

import type { ManifestGraphEdge, ManifestGraphFile } from '../src/node-manifest-graph.ts';
import { nodeNextHookAliasRoleData } from '../src/node-next-hook-alias-role.ts';

const CALLER = 'authored-caller-id';
const TARGET = '/authored/node_modules/styled-jsx/index.js';
const SHA256 = 'a'.repeat(64);
const ALIAS = { request: 'styled-jsx', target: TARGET };
const RUNTIME = '\0rolldown/runtime.js';

function graph() {
  return {
    sources: new Map<string, ManifestGraphFile>([
      [CALLER, { file: '/authored/caller.cjs', sha256: 'b'.repeat(64) }],
    ]),
    imports: new Map<string, readonly ManifestGraphEdge[]>([[CALLER, []]]),
    importers: new Map<string, readonly string[]>(),
    retained: new Set([CALLER]),
  };
}

describe('fixed hook alias execution-role DATA', () => {
  it('selects only unqualified resolution metadata when no retained request targets the alias', () => {
    const data = nodeNextHookAliasRoleData(graph(), ALIAS);

    expect(data).toStrictEqual({
      qualification: 'UNQUALIFIED DATA',
      requiresOwned: false,
      sha256: undefined,
    });
    expect(Object.isFrozen(data)).toBe(true);
  });

  it('keeps a recorded unretained physical digest without granting execution authority', () => {
    const own = graph();
    own.sources.set('unretained-id', { file: TARGET, sha256: SHA256 });

    expect(nodeNextHookAliasRoleData(own, ALIAS)).toStrictEqual({
      qualification: 'UNQUALIFIED DATA',
      requiresOwned: false,
      sha256: SHA256,
    });
  });

  it('requires existing ownership for an already retained physical target even without an edge', () => {
    const own = graph();
    own.sources.set('retained-target', { file: TARGET, sha256: SHA256 });
    own.retained.add('retained-target');

    expect(nodeNextHookAliasRoleData(own, ALIAS)?.requiresOwned).toBe(true);
  });

  it.each([
    { specifier: 'styled-jsx', target: 'different-id' },
    { specifier: './physical-alias', target: TARGET },
  ])('requires ownership for a matching request or direct target: $specifier', (edge) => {
    const own = graph();
    own.imports.set(CALLER, [edge]);

    expect(nodeNextHookAliasRoleData(own, ALIAS)?.requiresOwned).toBe(true);
  });

  it('maps actual graph target IDs to physical source identity', () => {
    const own = graph();
    own.sources.set('different-graph-id', { file: TARGET, sha256: SHA256 });
    own.imports.set(CALLER, [{ specifier: './relative', target: 'different-graph-id' }]);

    expect(nodeNextHookAliasRoleData(own, ALIAS)?.requiresOwned).toBe(true);
  });

  it('does not count an edge from a pruned caller as retained execution', () => {
    const own = graph();
    own.imports.set('pruned-caller', [{ specifier: 'styled-jsx', target: TARGET }]);

    expect(nodeNextHookAliasRoleData(own, ALIAS)?.requiresOwned).toBe(false);
  });

  it('refuses conflicting original descriptors for one physical target', () => {
    const own = graph();
    own.sources.set('first-id', { file: TARGET, sha256: SHA256 });
    own.sources.set('second-id', { file: TARGET, sha256: 'c'.repeat(64) });

    expect(nodeNextHookAliasRoleData(own, ALIAS)).toBeUndefined();
  });

  it('refuses an absent import inventory', () => {
    expect(nodeNextHookAliasRoleData({ ...graph(), imports: undefined }, ALIAS)).toBeUndefined();
  });

  it('refuses a missing retained physical caller row', () => {
    const own = graph();
    own.imports.delete(CALLER);

    expect(nodeNextHookAliasRoleData(own, ALIAS)).toBeUndefined();
  });

  it('refuses a retained caller without a physical descriptor even when an import row exists', () => {
    const own = graph();
    own.sources.delete(CALLER);

    expect(nodeNextHookAliasRoleData(own, ALIAS)).toBeUndefined();
  });

  it('supports the exact graph-only runtime identity already accepted by the original proof', () => {
    const own = graph();
    own.retained.add(RUNTIME);

    expect(nodeNextHookAliasRoleData(own, ALIAS)?.requiresOwned).toBe(false);
  });

  it('inspects a compiler helper import row when it is present', () => {
    const own = graph();
    own.retained.add(RUNTIME);
    own.imports.set(RUNTIME, [{ specifier: 'styled-jsx', target: TARGET }]);

    expect(nodeNextHookAliasRoleData(own, ALIAS)?.requiresOwned).toBe(true);
  });

  it.each(['\0rolldown/runtime.js?wrapper', '\0commonjs-proxy:/authored/target'])(
    'does not infer missing wrapper rows from a name: %s',
    (id) => {
      const own = graph();
      own.retained.add(id);

      expect(nodeNextHookAliasRoleData(own, ALIAS)).toBeUndefined();
    },
  );

  it('does not treat a physical source descriptor at the compiler ID as a graph-only helper', () => {
    const own = graph();
    own.retained.add(RUNTIME);
    own.sources.set(RUNTIME, { file: '/authored/physical.cjs', sha256: SHA256 });

    expect(nodeNextHookAliasRoleData(own, ALIAS)).toBeUndefined();
  });

  it('permits ordinary builtin target identities without evaluating a module', () => {
    const own = graph();
    own.imports.set(CALLER, [{ specifier: 'path', target: 'node:path' }]);

    expect(nodeNextHookAliasRoleData(own, ALIAS)?.requiresOwned).toBe(false);
  });

  it('refuses an unclassified nonbuiltin target that could hide physical identity', () => {
    const own = graph();
    own.imports.set(CALLER, [{ specifier: './relative', target: '\0unclassified-wrapper' }]);

    expect(nodeNextHookAliasRoleData(own, ALIAS)).toBeUndefined();
  });

  it('does not cache a previous no-execution result after the authored inventory changes', () => {
    const own = graph();

    expect(nodeNextHookAliasRoleData(own, ALIAS)?.requiresOwned).toBe(false);

    own.imports.set(CALLER, [{ specifier: 'styled-jsx', target: TARGET }]);

    expect(nodeNextHookAliasRoleData(own, ALIAS)?.requiresOwned).toBe(true);
  });
});
