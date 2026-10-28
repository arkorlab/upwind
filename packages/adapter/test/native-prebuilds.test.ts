import { describe, expect, it } from 'vitest';

import { nodeGypPrebuildDirectory, nodeGypPrebuildFile } from '../src/native-prebuilds.ts';

const TARGET = { abi: '137', uv: '1' };

describe('reviewed package-local node-gyp-build selection DATA', () => {
  it('prefers the matching single-architecture tuple without depending on directory order', () => {
    const names = ['linux-arm64', 'linux-x64+arm64', 'darwin-x64', 'linux-x64'];

    expect(nodeGypPrebuildDirectory(names)).toBe('linux-x64');
    expect(nodeGypPrebuildDirectory(names.toReversed())).toBe('linux-x64');
    expect(nodeGypPrebuildDirectory(['linux-x64+arm64'])).toBe('linux-x64+arm64');
  });

  it('refuses equally specific matching tuples', () => {
    expect(() => nodeGypPrebuildDirectory(['linux-x64+arm64', 'linux-arm64+x64'])).toThrow(
      'filesystem order',
    );
  });

  it.each(['linux-', 'linux-x64+', 'linux--x64', 'darwin-x64', 'linux-arm64'])(
    'ignores the nonmatching tuple %s',
    (name) => {
      expect(nodeGypPrebuildDirectory([name])).toBeUndefined();
    },
  );

  it('preserves runtime, ABI and recognized-tag specificity precedence', () => {
    const names = [
      'unknown.node',
      'abi137.node',
      'node.napi.glibc.uv1.node',
      'node.abi137.node',
      'node.abi137.glibc.node',
    ];

    expect(nodeGypPrebuildFile(names, TARGET)).toBe('node.abi137.glibc.node');
    expect(nodeGypPrebuildFile(names.toReversed(), TARGET)).toBe('node.abi137.glibc.node');
  });

  it.each([
    'electron.abi137.node',
    'node-webkit.napi.node',
    'node.abi136.node',
    'node.napi.uv2.node',
    'node.napi.armv8.node',
    'node.napi.musl.node',
    'node.napi.js',
  ])('ignores the nonmatching binary %s', (name) => {
    expect(nodeGypPrebuildFile([name], TARGET)).toBeUndefined();
  });

  it('retains the original NAPI exception and later-tag overwrite semantics', () => {
    expect(nodeGypPrebuildFile(['node.abi136.napi.node'], TARGET)).toBe('node.abi136.napi.node');
    expect(nodeGypPrebuildFile(['electron.node.abi136.abi137.musl.glibc.node'], TARGET)).toBe(
      'electron.node.abi136.abi137.musl.glibc.node',
    );
  });

  it('refuses equal binary ranks and the original comparator inconsistent ABI cases', () => {
    expect(() =>
      nodeGypPrebuildFile(['first.node.napi.node', 'second.node.napi.node'], TARGET),
    ).toThrow('filesystem order');
    expect(() =>
      nodeGypPrebuildFile(['node.abi137.node', 'node.abi136.napi.node'], TARGET),
    ).toThrow('ABI selector order');
    expect(() => nodeGypPrebuildFile(['node.abi.napi.node'], TARGET)).toThrow('ABI selector order');
  });

  it('allows lower-priority ties when one higher-priority winner is proved', () => {
    expect(
      nodeGypPrebuildFile(['first.napi.node', 'second.napi.node', 'node.abi137.node'], TARGET),
    ).toBe('node.abi137.node');
  });

  it('refuses path-shaped entries, unproved targets and oversized directories', () => {
    expect(() => nodeGypPrebuildDirectory(['../linux-x64'])).toThrow('basename');
    expect(() => nodeGypPrebuildFile(['../node.napi.node'], TARGET)).toThrow('basename');
    expect(() => nodeGypPrebuildFile(['node.napi.node'], { ...TARGET, abi: '' })).toThrow(
      'ABI or libuv',
    );
    expect(() => nodeGypPrebuildDirectory(Array.from({ length: 4097 }, () => 'other'))).toThrow(
      'entry limit',
    );
  });
});
