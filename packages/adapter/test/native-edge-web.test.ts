import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';

import { type Plugin, rolldown } from 'rolldown';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NATIVE_EDGE_WEB_GLOBALS,
  NATIVE_EDGE_WEB_OBJECT,
  nativeEdgeWebPlugin,
} from '../src/native/edge-web.ts';

const require = createRequire(import.meta.url);
const nextRequestFile = require.resolve('next/dist/server/web/spec-extension/request.js');
const SNIPPET = '\0snippet';
const ORIGIN = 'http://localhost/';

type NextRequestClass = new (input: string, init?: RequestInit) => Request;

function snippetPlugin(source: string): Plugin {
  return {
    name: 'snippet',
    resolveId: (id) => (id === SNIPPET ? id : null),
    load: (id) => (id === SNIPPET ? source : null),
  };
}

/** A module bundled as the native target bundles Edge code, with the Edge Runtime's two or without. */
async function edgeModule(input: string, web: boolean, plugins: Plugin[] = []): Promise<unknown> {
  await using bundle = await rolldown({
    input,
    platform: 'node',
    plugins: [...(web ? [nativeEdgeWebPlugin()] : []), ...plugins],
    transform: {
      ...(web && { inject: NATIVE_EDGE_WEB_OBJECT }),
      define: {
        ...(web && NATIVE_EDGE_WEB_GLOBALS),
        'process.env.NODE_ENV': '"production"',
        'process.env.NEXT_RUNTIME': '"edge"',
      },
    },
  });
  const { output } = await bundle.generate({ format: 'cjs', codeSplitting: false });
  const chunk = output.find((item) => item.type === 'chunk');
  if (chunk?.type !== 'chunk') throw new Error('the Edge module was not generated');
  const module = { exports: {} as unknown };
  // eslint-disable-next-line sonarjs/code-eval -- This evaluates a test-owned bundle in this realm, as the native server loads its Edge bundle.
  const factory = runInThisContext(`(function(exports, require, module) {\n${chunk.code}\n})`) as (
    exports: unknown,
    require: NodeJS.Require,
    module: { exports: unknown },
  ) => void;
  factory(module.exports, require, module);
  return module.exports;
}

async function nextRequest(web: boolean): Promise<NextRequestClass> {
  const exported = (await edgeModule(nextRequestFile, web)) as { NextRequest: NextRequestClass };
  return exported.NextRequest;
}

const BODY = 'hello';

function streamOfBody(): ReadableStream<Uint8Array> {
  return new Blob([BODY]).stream();
}

describe('the native Edge bundle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Whatever a module made of the two globals, as `stubGlobal` found them.
    vi.unstubAllGlobals();
  });

  it("reproduces Node.js refusing a body Next.js's Edge code hands it without the option", async () => {
    const NextRequest = await nextRequest(false);

    expect(() => new NextRequest(ORIGIN, { method: 'POST', body: streamOfBody() })).toThrow(
      'duplex option is required',
    );
  });

  it('takes the body as the Edge Runtime does, a request of Node.js still', async () => {
    const NextRequest = await nextRequest(true);
    const request = new NextRequest(ORIGIN, { method: 'POST', body: streamOfBody() });

    expect(request).toBeInstanceOf(Request);
    await expect(request.text()).resolves.toBe(BODY);
  });

  it("leaves Node.js's own Request to the rest of the process", async () => {
    const before = Request;
    await nextRequest(true);

    expect(Request).toBe(before);
    expect(() => new Request(ORIGIN, { method: 'POST', body: streamOfBody() })).toThrow(
      'duplex option is required',
    );
  });

  it("knows a request made outside it for Node.js's", async () => {
    const isRequest = (await edgeModule(SNIPPET, true, [
      snippetPlugin('module.exports = (value) => value instanceof Request;'),
    ])) as (value: unknown) => boolean;

    expect(isRequest(new Request(ORIGIN))).toBe(true);
    expect(isRequest({})).toBe(false);
  });

  it('fetches a body through the global fetch as it stands at the call', async () => {
    const send = (await edgeModule(SNIPPET, true, [
      snippetPlugin('module.exports = (url, init) => fetch(url, init);'),
    ])) as (url: string, init?: RequestInit) => Promise<Response>;
    const patched = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const body = streamOfBody();
    const plain = { method: 'GET' };

    await send(ORIGIN, { method: 'POST', body });
    await send(ORIGIN, plain);

    expect(patched.mock.calls).toStrictEqual([
      [ORIGIN, { method: 'POST', body, duplex: 'half' }],
      [ORIGIN, plain],
    ]);
    expect(patched.mock.calls[1]?.[1]).toBe(plain);
  });

  it('calls the fetch a module kept when it installs its own over it', async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', base);
    const send = (await edgeModule(SNIPPET, true, [
      snippetPlugin(
        [
          'const kept = fetch;',
          'globalThis.fetch = (...args) => kept(...args);',
          'module.exports = (url, init) => fetch(url, init);',
        ].join('\n'),
      ),
    ])) as (url: string, init?: RequestInit) => Promise<Response>;
    const body = streamOfBody();

    await expect(send(ORIGIN, { method: 'POST', body })).resolves.toBeInstanceOf(Response);
    expect(base.mock.calls).toStrictEqual([[ORIGIN, { method: 'POST', body, duplex: 'half' }]]);
  });

  it("keeps one fetch while the global stays, with what a patch hung on the global's", async () => {
    vi.stubGlobal('fetch', Object.assign(vi.fn<typeof fetch>(), { __nextPatched: true }));
    const read = (await edgeModule(SNIPPET, true, [
      snippetPlugin('module.exports = () => fetch;'),
    ])) as () => typeof fetch & { readonly __nextPatched?: boolean };

    expect(read()).toBe(read());
    expect(read().__nextPatched).toBe(true);
  });

  it('assigns the globals where a module assigns either name', async () => {
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('Request', Request);
    const assign = (await edgeModule(SNIPPET, true, [
      snippetPlugin('module.exports = (f, R) => { fetch = f; Request = R; };'),
    ])) as (replacementFetch: unknown, replacementRequest: unknown) => void;
    const replacementFetch = vi.fn<typeof fetch>();
    const replacementRequest = class {
      readonly replaced = true;
    };

    assign(replacementFetch, replacementRequest);

    expect(fetch).toBe(replacementFetch);
    expect(Request).toBe(replacementRequest);
  });

  it('builds a module that assigns either global, as a polyfill may', async () => {
    const exported = (await edgeModule(SNIPPET, true, [
      snippetPlugin(
        [
          'if (typeof fetch !== "function") fetch = () => undefined;',
          'if (typeof Request !== "function") Request = class {};',
          'module.exports = { fetch, Request };',
        ].join('\n'),
      ),
    ])) as { fetch: unknown; Request: unknown };

    expect(exported.fetch).toBeTypeOf('function');
    expect(exported.Request).toBeTypeOf('function');
  });
});
