import { describe, expect, it } from 'vitest';

import {
  auditFunction,
  auditNativePlacement,
  auditNodeFunction,
  type FunctionDependencies,
} from '../src/dependencies.ts';

function dependencies(externals: string[]): FunctionDependencies {
  return {
    buildOutput: [],
    packages: {},
    other: [],
    externals,
    stubs: [],
    patches: [],
    wasmModules: [],
    modules: [],
    size: { bytes: 0, gzipBytes: 0 },
    dynamicRequires: [],
    guardedRequires: [],
  };
}

describe('mixed native and Worker placement audit', () => {
  it.each([
    'cloudflare:email',
    'cloudflare:node',
    'cloudflare:sockets',
    'cloudflare:workers',
    'cloudflare:workflows',
  ])('keeps %s available during placement and rejects it in the final Node closure', (external) => {
    const input = dependencies([external]);

    expect(() => {
      auditNativePlacement('app', { app: '' }, input);
    }).not.toThrow();
    expect(() => {
      auditFunction('worker', { app: '' }, input);
    }).not.toThrow();
    expect(() => {
      auditNodeFunction('native', { app: '' }, input);
    }).toThrow(
      'not known to be provided',
    );
  });

  it('still refuses unknown platform modules before partitioning', () => {
    const input = dependencies(['cloudflare:unrecognized']);

    expect(() => {
      auditNativePlacement('app', { app: '' }, input);
    }).toThrow(
      'not known to be provided',
    );
  });

  it('admits genuine Node builtins during placement without extending Worker support', () => {
    const input = dependencies(['node:v8']);

    expect(() => {
      auditNativePlacement('app', { app: '' }, input);
    }).not.toThrow();
    expect(() => {
      auditNodeFunction('native', { app: '' }, input);
    }).not.toThrow();
    expect(() => {
      auditFunction('worker', { app: '' }, input);
    }).toThrow('not known to be provided');
  });
});
