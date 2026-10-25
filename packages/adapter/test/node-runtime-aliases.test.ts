import { describe, expect, it } from 'vitest';

import { nodeRuntimeAlias } from '../src/node-function.ts';

const RUNTIME = '/sdk/packages/runtime/src';

describe('node runtime module aliases', () => {
  it.each([
    ['./environment.ts', `${RUNTIME}/function.ts`, 'environment'],
    ['./fetch-response.ts', `${RUNTIME}/serve.ts`, 'fetch-response'],
    ['../fetch-response.js', `${RUNTIME}/cache/render.ts`, 'fetch-response'],
    ['../node-bridge.ts', `${RUNTIME}/cache/static-render.ts`, 'node-bridge'],
    ['../../resources.js', `${RUNTIME}/cache/nested/render.ts`, 'resources'],
    ['./cache/../node-bridge.js', `${RUNTIME}/function.ts`, 'node-bridge'],
  ])('resolves %s from its actual runtime importer', (source, importer, expected) => {
    expect(nodeRuntimeAlias(source, importer, RUNTIME)).toBe(expected);
  });

  it.each([
    ['./node-bridge.ts', '/project/node-bridge-caller.ts'],
    ['../src/node-bridge.ts', '/sdk/packages/runtime-other/caller.ts'],
    ['../src/node-bridge.ts', '/sdk/packages/runtime/caller.ts'],
    ['./environment.ts', `${RUNTIME}/cache/entry.ts`],
    ['./fetch-response.ts', '/project/serve.ts'],
    ['../unrelated/node-bridge.ts', `${RUNTIME}/cache/entry.ts`],
    ['node-bridge.ts', `${RUNTIME}/function.ts`],
    ['/sdk/packages/runtime/src/node-bridge.ts', `${RUNTIME}/function.ts`],
  ])('does not alias unrelated module %s from %s', (source, importer) => {
    expect(nodeRuntimeAlias(source, importer, RUNTIME)).toBeUndefined();
  });

  it('leaves a relative request with no importer to the ordinary resolver', () => {
    expect(nodeRuntimeAlias('./node-bridge.ts', undefined, RUNTIME)).toBeUndefined();
  });
});
