import { isProxy } from 'node:util/types';

import { describe, expect, it } from 'vitest';

import { nodeNextHookRecord } from '../src/node-next-hook-record.ts';

const ROOT = 'node_modules/next';
function input() {
  return {
    record: {
      schema: 1,
      profile: 'next-16.4.3-require-hook-v1',
      nodeVersion: '24.22.1',
      archivePath: `${ROOT}/dist/server/require-hook.js`,
      sha256: 'e82f0ceba88d025c725ea3062974ad9d7a54a892df8c34a525cb129202387db8',
      bytes: 3066,
    },
    aliases: [
      { request: 'styled-jsx', target: 'node_modules/styled-jsx/index.js' },
      { request: 'styled-jsx/style', target: 'node_modules/styled-jsx/style.js' },
      { request: 'styled-jsx/style.js', target: 'node_modules/styled-jsx/style.js' },
    ],
    sharedRuntimeEdges: [
      {
        caller: 'app/page.js',
        specifier: './image-config-context.shared-runtime',
        target: `${ROOT}/dist/server/route-modules/pages/vendored/contexts/image-config-context.js`,
      },
    ],
  };
}
function read(value: unknown) {
  return () => nodeNextHookRecord(value, isProxy);
}

describe('fixed Next require-hook bootstrap DATA', () => {
  it.each([0, 1, 2, 3])('copies %i ordered default aliases without loading modules', (count) => {
    const own = input();
    own.aliases = own.aliases.slice(0, count);
    const copied = nodeNextHookRecord(own, isProxy);
    own.aliases.length = 0;
    own.record.archivePath = 'changed';
    own.sharedRuntimeEdges[0]!.target = 'changed';

    expect(copied.aliases).toHaveLength(count);
    expect(copied.record.archivePath).toBe(`${ROOT}/dist/server/require-hook.js`);
    expect(copied.sharedRuntimeEdges[0]?.target).toContain('/vendored/contexts/');
    expect(Object.isFrozen(copied)).toBe(true);
    expect(Object.isFrozen(copied.record)).toBe(true);
    expect(Object.isFrozen(copied.sharedRuntimeEdges[0])).toBe(true);
  });

  it('accepts nested owned Next coordinates and an empty shared-runtime inventory', () => {
    const own = input();
    own.record.archivePath = `app/${ROOT}/dist/server/require-hook.js`;
    own.sharedRuntimeEdges = [];

    expect(read(own)).not.toThrow();
  });

  it.each([
    ['schema', 2],
    ['profile', 'other'],
    ['nodeVersion', '24.22.2'],
    ['sha256', '0'.repeat(64)],
    ['bytes', 3065],
  ])('refuses a changed fixed source field %s', (key, value) => {
    const own = input();
    Reflect.set(own.record, key, value);

    expect(read(own)).toThrow('fixed source identity');
  });

  it.each([
    '',
    '/absolute',
    '../escape',
    'a//b',
    'a/./b',
    'a/../b',
    'a\\b',
    'a:b',
    'a\0b',
    'x'.repeat(4097),
  ])('refuses an unsafe archive path %j', (name) => {
    const own = input();
    own.aliases[0]!.target = name;

    expect(read(own)).toThrow('archive path boundary');
  });

  it.each(['node_modules/other/dist/server/require-hook.js', `${ROOT}/dist/server/other.js`])(
    'refuses a foreign hook coordinate %s',
    (name) => {
      const own = input();
      own.record.archivePath = name;

      expect(read(own)).toThrow('fixed');
    },
  );

  it.each(['unknown', 'styled-jsx/style.js'])(
    'refuses unknown or unordered aliases %s',
    (request) => {
      const own = input();
      own.aliases[0]!.request = request;

      expect(read(own)).toThrow('default alias');
    },
  );

  it('refuses duplicate aliases and oversized inventories', () => {
    const own = input();
    own.aliases[1]!.request = 'styled-jsx';

    expect(read(own)).toThrow('default alias');

    own.aliases.push(own.aliases[0]!);

    expect(read(own)).toThrow('oversized');
  });

  it.each(['./ordinary', 'a\0b.shared-runtime'])(
    'refuses a non-qualified edge specifier %j',
    (specifier) => {
      const own = input();
      own.sharedRuntimeEdges[0]!.specifier = specifier;

      expect(read(own)).toThrow('shared-runtime');
    },
  );

  it('deduplicates identical edges but refuses conflicting targets', () => {
    const own = input();
    own.sharedRuntimeEdges.push({ ...own.sharedRuntimeEdges[0]! });

    expect(nodeNextHookRecord(own, isProxy).sharedRuntimeEdges).toHaveLength(1);

    own.sharedRuntimeEdges[1]!.target = `${ROOT}/dist/server/route-modules/pages/vendored/contexts/other.js`;

    expect(read(own)).toThrow('conflicting');
  });

  it('refuses shared targets outside the same Next contexts directory', () => {
    const own = input();
    own.sharedRuntimeEdges[0]!.target = 'node_modules/other/context.js';

    expect(read(own)).toThrow('shared-runtime');
  });

  it.each(['record', 'aliases', 'sharedRuntimeEdges'])(
    'never invokes a DATA accessor for %s',
    (key) => {
      const own = input();
      let calls = 0;
      Object.defineProperty(own, key, {
        get() {
          calls += 1;
        },
      });

      expect(read(own)).toThrow('own DATA');
      expect(calls).toBe(0);
    },
  );

  it('refuses nested accessors, sparse arrays and extra array keys', () => {
    const own = input();
    let calls = 0;
    Object.defineProperty(own.aliases[0], 'target', {
      get() {
        calls += 1;
        return '';
      },
    });

    expect(read(own)).toThrow('own DATA');
    expect(calls).toBe(0);

    const sparse = input();
    Reflect.deleteProperty(sparse.aliases, '0');

    expect(read(sparse)).toThrow('non-dense');
    expect(read({ ...input(), aliases: Object.assign([], { extra: true }) })).toThrow('non-dense');
  });

  it('rejects proxies before any reflection trap', () => {
    let calls = 0;
    const proxy = new Proxy(input(), {
      ownKeys() {
        calls += 1;
        return [];
      },
      getOwnPropertyDescriptor() {
        calls += 1;
      },
      getPrototypeOf() {
        calls += 1;
        return null;
      },
    });

    expect(read(proxy)).toThrow('proxy');
    expect(calls).toBe(0);
  });

  it('refuses unknown keys and non-plain DATA owners', () => {
    expect(read({ ...input(), other: true })).toThrow('unexpected DATA keys');

    const foreign: unknown = Object.assign(Object.create({}), input());

    expect(read(foreign)).toThrow('non-plain');
  });
});
