import { describe, expect, it } from 'vitest';

import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';

const FIELDS = [
  '_initPaths',
  '_nodeModulePaths',
  '_pathCache',
  '_readPackage',
  '_resolveLookupPaths',
  '_stat',
];

describe('original Node resolver customization boundaries', () => {
  it.each(FIELDS)('refuses direct resolver state or hooks through %s', (name) => {
    expect(
      dynamicNodeClosureRefusal('/authored/loader.js', `require('node:module').${name};`),
    ).toContain('loader');
  });

  it.each(FIELDS)('refuses destructured resolver state or hooks through %s', (name) => {
    expect(
      dynamicNodeClosureRefusal('/authored/loader.js', `const {${name}:value}=require('module');`),
    ).toContain('loader');
  });

  it('preserves ordinary metadata on a local object', () => {
    expect(
      dynamicNodeClosureRefusal(
        '/authored/local.js',
        'const local={_pathCache:{value:1},_stat:1};exports.value=local._pathCache.value;',
      ),
    ).toBeUndefined();
  });
});
