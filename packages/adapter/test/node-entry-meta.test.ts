import path from 'node:path';
import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { appEntrySource } from '../src/app-entry.ts';

interface RouteModule {
  distDir: string;
}
interface Entry {
  readonly routeModule?: RouteModule;
  readonly handler: (...args: unknown[]) => unknown;
  readonly config?: unknown;
}
interface Call {
  readonly receiver: unknown;
  readonly args: readonly unknown[];
}

function waitUntil(): Promise<void> {
  return Promise.resolve();
}

function fixture(nodeRequestMeta: boolean, asynchronous = false) {
  const calls: Call[] = [];
  const marker = {};
  let configReads = 0;
  let loads = 0;
  const original: Entry = {
    routeModule: { distDir: '/build-machine/.next' },
    get config() {
      configReads += 1;
      return marker;
    },
    handler(...args) {
      // eslint-disable-next-line unicorn/no-this-outside-of-class -- Verify the generated wrapper preserves this exact route namespace receiver.
      calls.push({ receiver: this, args });
      return marker;
    },
  };
  const source = appEntrySource([{ id: '/api/native', filePath: '/bundle/project/api.js' }], {
    external: true,
    runtimeDistDir: '.next',
    nodeRequestMeta,
  });
  const module = { exports: {} as { entries: Record<string, () => Entry | Promise<Entry>> } };
  // eslint-disable-next-line sonarjs/code-eval -- Execute only the generated SDK entry with an inert route object and fixed Node path service.
  new Script(source).runInNewContext({
    module,
    process: { cwd: () => '/bundle/project' },
    require(specifier: string) {
      if (specifier === 'node:path') return path;
      if (specifier !== '/bundle/project/api.js') throw new Error('Unexpected entry import');
      loads += 1;
      return asynchronous ? Promise.resolve(original) : original;
    },
  });
  const load = module.exports.entries['/api/native'];
  if (load === undefined) throw new Error('Missing generated API entry');
  return { calls, original, marker, load, configReads: () => configReads, loads: () => loads };
}

describe('trusted request metadata for native Node handlers', () => {
  it('injects the runtime dist directory while preserving receiver, context, arguments and result', async () => {
    const own = fixture(true);
    const entry = await own.load();
    const request = {};
    const response = {};
    const context = {
      waitUntil,
      requestMeta: { distDir: '/untrusted', relativeProjectDir: '/untrusted', invocation: 'first' },
    };
    const result = entry.handler(request, response, context, 'extra');

    expect(result).toBe(own.marker);
    // eslint-disable-next-line vitest/prefer-strict-equal -- VM-created metadata has a distinct Object prototype; compare all values.
    expect(own.calls).toEqual([
      {
        receiver: own.original,
        args: [
          request,
          response,
          {
            waitUntil,
            requestMeta: {
              distDir: '/bundle/project/.next',
              relativeProjectDir: '.',
              invocation: 'first',
            },
          },
          'extra',
        ],
      },
    ]);
    expect(own.calls[0]?.receiver).toBe(own.original);
    expect(context.requestMeta).toStrictEqual({
      distDir: '/untrusted',
      relativeProjectDir: '/untrusted',
      invocation: 'first',
    });
    expect(entry.routeModule).toBe(own.original.routeModule);
    expect(own.configReads()).toBe(0);
  });

  it('normalizes asynchronous entries once and keeps request metadata separate between invocations', async () => {
    const own = fixture(true, true);
    const first = await own.load();
    const second = await own.load();
    first.handler({}, {}, { requestMeta: { invocation: 'first' } });
    second.handler({}, {}, { requestMeta: { invocation: 'second' } });

    expect(first).toBe(second);
    expect(own.loads()).toBe(1);
    // eslint-disable-next-line vitest/prefer-strict-equal -- These plain request metadata objects originate in the generated entry's VM realm.
    expect(own.calls.map((call) => call.args[2])).toEqual([
      {
        requestMeta: {
          invocation: 'first',
          distDir: '/bundle/project/.next',
          relativeProjectDir: '.',
        },
      },
      {
        requestMeta: {
          invocation: 'second',
          distDir: '/bundle/project/.next',
          relativeProjectDir: '.',
        },
      },
    ]);
  });

  it('keeps the existing Worker entry behavior when the Node option is absent', async () => {
    const own = fixture(false);
    const entry = await own.load();

    expect(entry).toBe(own.original);
    expect(entry.handler).toBe(own.original.handler);
    expect(own.configReads()).toBe(0);
  });
});
