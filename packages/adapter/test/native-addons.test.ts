import { describe, expect, it } from 'vitest';

import { AuditError, auditFunction, type FunctionDependencies } from '../src/dependencies.ts';
import { nativeAddonAuditError } from '../src/native-addons.ts';

const NATIVE = {
  id: '/native',
  assets: {
    'node_modules/native-addon/build/Release/addon.node': '/build/addon.node',
    'node_modules/native-addon/index.js': '/build/index.js',
  },
};

function refusedGraph(): AuditError {
  const record: FunctionDependencies = {
    buildOutput: [],
    packages: {},
    other: [],
    externals: [],
    stubs: [],
    patches: [],
    dynamicRequires: ['bindings/index.js:30: require(binary)'],
    wasmModules: [],
    modules: [],
    size: { bytes: 0, gzipBytes: 0 },
  };
  try {
    auditFunction('app', { app: 'module.exports = require(binary);' }, record);
  } catch (error) {
    if (error instanceof AuditError) return error;
    throw error;
  }
  throw new Error('The authored runtime graph must fail its existing audit');
}

describe('native addon context for a rejected Function graph', () => {
  it('keeps the actual audit refusal and identifies its retained server trace', () => {
    const original = refusedGraph();
    const failure = nativeAddonAuditError(original, [NATIVE]);

    expect(failure).toBeInstanceOf(AuditError);
    expect(failure.cause).toBe(original);
    expect(failure.message).toContain(original.message);
    expect(failure.message).toContain(
      '"/native": "node_modules/native-addon/build/Release/addon.node"',
    );
    expect(failure.message).toContain(
      'A prerendered response does not make its server entry build-only',
    );
  });

  it('does not confuse a build-only package or another Function with an owned native trace', () => {
    const original = refusedGraph();
    const ordinary = {
      id: '/static',
      assets: { 'content.json': '/build/content.json', 'entry.js': '/build/entry.js' },
    };

    expect(nativeAddonAuditError(original, [])).toBe(original);
    expect(nativeAddonAuditError(original, [ordinary])).toBe(original);
  });

  it('reports only original traces and retains native rejection when unrelated routes are present', () => {
    const original = refusedGraph();
    const traces = [
      { id: '/ordinary', assets: { 'a.js': '/build/a.js' } },
      NATIVE,
      { id: '/looks-native', assets: { 'addon.node.js': '/build/addon.node.js' } },
    ];
    const before = JSON.stringify(traces);
    const failure = nativeAddonAuditError(original, traces);

    expect(failure.cause).toBe(original);
    expect(failure.message).not.toContain('/ordinary');
    expect(failure.message).not.toContain('/looks-native');
    expect(JSON.stringify(traces)).toBe(before);
  });

  it('escapes labels and bounds additional routes, files and label lengths', () => {
    const traces = Array.from({ length: 7 }, (_, index) => {
      const assets = Object.fromEntries(
        Array.from({ length: 5 }, (_, file) => {
          return [`asset-${String(file)}.node`, `/build/${String(file)}.node`];
        }),
      );
      return { id: `/route-${String(index)}\n\u{2028}${'x'.repeat(200)}`, assets };
    });
    const failure = nativeAddonAuditError(refusedGraph(), traces);
    const entries = failure.message.split('\n').filter((line) => line.startsWith('  - "/route-'));

    expect(entries).toHaveLength(5);
    expect(entries[0]).toContain('\\n');
    expect(entries[0]).toContain('\\u2028');
    expect(failure.message).toContain('(+2 more traced files)');
    expect(failure.message).toContain('2 more server entries');
    expect(failure.message).not.toContain('x'.repeat(200));
  });
});
