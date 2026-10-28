import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { OUT_DIR_NAME } from '@stayingupwind/adapter';
import type { BlobRef, DeploymentBundle } from '@stayingupwind/core/bundle';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { createId } from '@stayingupwind/core/util';
import {
  encodeGateShell,
  GATE_ANSWER_HEADER,
  GATE_PASS,
  GATE_ROUTE_HEADER,
  GATE_SHELL,
  GATE_SHELL_CONTENT_TYPE,
  GATE_URL_HEADER,
} from '@stayingupwind/host/bindings';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gateForwarder, gateServices } from '../src/gates.ts';
import { runWorkers } from '../src/miniflare.ts';
import { type LocalStack, startStack } from '../src/stack.ts';
import { GATE_UNREACHABLE_HEADER } from '../src/workers/protocol.ts';

/**
 * A route's gate as a local stack reaches it: at an address of its own, from Node, with what the
 * edge hands it (`gateForwarder`) — and a stack whose build declares one, asking it before the
 * Function, as a deployed edge does.
 */

const START_MS = 60_000;
const GATED = '/gated';
const GATE = 'checker';
/** A gate's own credential, which every request the stack sends it carries. */
const CREDENTIAL = { authorization: 'Bearer gate-secret' };

/** What a gate was asked: its method, its path at the gate, and its headers. */
interface Asked {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly headers: IncomingHttpHeaders;
}

/** How the gate answers, as a test sets it. */
type Answer = (asked: Asked) => {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer | string;
};

/** A gate on this machine: what it was asked, and the answer it gives, which a test may set. */
interface Gate {
  readonly url: URL;
  readonly asked: Asked[];
  answer: Answer;
  close(): Promise<void>;
}

function passing(): ReturnType<Answer> {
  return { status: 200, headers: { [GATE_ANSWER_HEADER]: GATE_PASS } };
}

async function startGate(): Promise<Gate> {
  const asked: Asked[] = [];
  const gate: { answer: Answer } = { answer: passing };
  const server: Server = createServer((request, response) => {
    const seen = { method: request.method, path: request.url, headers: request.headers };
    asked.push(seen);
    const answer = gate.answer(seen);
    response.writeHead(answer.status, answer.headers);
    response.end(answer.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${String(port)}/gate`),
    asked,
    get answer() {
      return gate.answer;
    },
    set answer(answer: Answer) {
      gate.answer = answer;
    },
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

/** A port nothing listens on: one a server listened on and let go of. */
async function closedPort(): Promise<string> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return `http://127.0.0.1:${String(port)}/gate`;
}

/** What the edge hands a gate, as a binding hands it on. */
function handed(method = 'GET'): Request {
  return new Request('https://site.example/gated?tab=open', {
    method,
    headers: { [GATE_ROUTE_HEADER]: GATED, cookie: 'theme=dark' },
  });
}

describe('a gate a stack reaches at an address of its own', () => {
  const state: { gate?: Gate } = {};

  function gate(): Gate {
    if (state.gate === undefined) {
      throw new Error('the gate did not start');
    }
    return state.gate;
  }

  beforeAll(async () => {
    state.gate = await startGate();
  });

  afterAll(async () => {
    await state.gate?.close();
  });

  /**
   * Its method, the visitor's headers, the URL the visitor asked for, and the gate's own headers
   * besides — asked on the gate's own host, the visitor's being in the URL it is told.
   */
  it('is sent what the edge hands it, the URL the visitor asked for beside it', async () => {
    gate().answer = passing;
    const forward = gateForwarder({ url: gate().url.href, headers: CREDENTIAL });

    const answer = await forward(handed('HEAD'));
    const seen = gate().asked.at(-1);

    expect(answer.headers.get(GATE_ANSWER_HEADER)).toBe(GATE_PASS);
    expect(seen?.method).toBe('HEAD');
    expect(seen?.path).toBe('/gate');
    expect(seen?.headers[GATE_URL_HEADER]).toBe('https://site.example/gated?tab=open');
    expect(seen?.headers[GATE_ROUTE_HEADER]).toBe(GATED);
    expect(seen?.headers.cookie).toBe('theme=dark');
    expect(seen?.headers.authorization).toBe(CREDENTIAL.authorization);
    expect(seen?.headers.host).toBe(gate().url.host);
  });

  /** As the gate answered it: the coding and length describe the unchanged compressed bytes. */
  it('answers what the gate answered, as it reads', async () => {
    const bytes = gzipSync('revoked');
    gate().answer = () => {
      return {
        status: 403,
        headers: {
          'content-encoding': 'gzip',
          'content-length': String(bytes.byteLength),
          'x-said': 'no',
        },
        body: bytes,
      };
    };

    const answer = await gateForwarder({ url: gate().url.href })(handed());

    expect(answer.status).toBe(403);
    expect(answer.headers.get('x-said')).toBe('no');
    expect(answer.headers.get('content-encoding')).toBe('gzip');
    expect(answer.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(Buffer.from(await answer.arrayBuffer())).toStrictEqual(bytes);
  });

  /** A `HEAD`'s answer has no body: its coding and length are those a `GET` would have. */
  it('answers a HEAD with the coding and length the gate said', async () => {
    gate().answer = () => {
      return {
        status: 200,
        headers: { 'content-encoding': 'gzip', 'content-length': '27' },
      };
    };

    const answer = await gateForwarder({ url: gate().url.href })(handed('HEAD'));

    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-encoding')).toBe('gzip');
    expect(answer.headers.get('content-length')).toBe('27');
  });

  /** One that cannot be reached is said to be so, for the edge Worker to fail the binding with. */
  it('says a gate it cannot reach could not be reached', async () => {
    const answer = await gateForwarder({ url: await closedPort() })(handed());

    expect(answer.headers.get(GATE_UNREACHABLE_HEADER)).toMatch(/ECONNREFUSED/u);
  });

  it.each([
    'http://user@localhost/gate',
    'http://:secret@localhost/gate',
    'https://user:secret@localhost/gate',
  ])('refuses a gate URL carrying credentials at startup: %s', (url) => {
    expect(() => gateServices({ rules: { url } })).toThrow(/without credentials/u);
  });

  it.each([
    { 'not a header': 'value' },
    { 'bad\tname': 'value' },
    { '': 'value' },
    { authorization: 'Bearer token\rnext' },
    { authorization: 'Bearer token\nnext' },
  ])('refuses malformed configured gate headers at startup: %s', (headers) => {
    expect(() => gateServices({ rules: { url: gate().url.href, headers } })).toThrow(/header/iu);
  });

  it.each([{ 'X-Api-Token': 'token' }, { authorization: 'Bearer token', 'x-empty': '' }])(
    'keeps valid configured gate headers accepted: %s',
    (headers) => {
      const services = gateServices({ rules: { url: gate().url.href, headers } });

      expect(Object.keys(services)).toStrictEqual(['GATE__RULES']);
    },
  );

  it('binds each gate under the name a deployed edge binds it by, and no gate that is none', () => {
    const bound = gateServices({ 'content-rules': { url: gate().url.href } });

    expect(Object.keys(bound)).toStrictEqual(['GATE__CONTENT_RULES']);
    expect(() => gateServices({ Rules: { url: gate().url.href } })).toThrow(/no gate's name/u);
    expect(() => gateServices({ rules: { url: '/gate' } })).toThrow(/at an http\(s\) URL/u);

    // Each parses as a URL, which no HTTP(S) transport can ask a gate at.
    for (const url of ['localhost:4000', 'ftp://localhost/gate', 'file:///gate']) {
      expect(() => gateServices({ rules: { url } })).toThrow(/at an http\(s\) URL/u);
    }

    // The protocol's own headers are the edge's to say, in any case.
    for (const header of ['x-upwind-gate-url', 'X-Upwind-Gate-Route', 'x-upwind-gate-answer']) {
      expect(() =>
        gateServices({ rules: { headers: { [header]: 'x' }, url: gate().url.href } }),
      ).toThrow(/may not set/u);
    }
  });
});

/** A gate that answers nothing: what it was asked closes only as the one who asked lets go of it. */
interface SilentGate {
  readonly url: string;
  /** Settles as the request it was asked closes, unanswered. */
  readonly letGo: Promise<void>;
  close(): Promise<void>;
}

async function startSilentGate(): Promise<SilentGate> {
  const asked: { resolve?: () => void } = {};
  const letGo = new Promise<void>((resolve) => {
    asked.resolve = resolve;
  });
  const server = createServer((_request, response) => {
    response.once('close', () => asked.resolve?.());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/gate`,
    letGo,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

/** A Worker that asks its gate, as the edge does, and lets go of what it asked after a moment. */
const ASKER = `
export default {
  async fetch(request, env) {
    try {
      await env.GATE__CHECKER.fetch('https://site.example/gated', { signal: AbortSignal.timeout(200) });
      return new Response('answered');
    } catch (error) {
      return new Response(error.name);
    }
  },
};
`;
/** Longer than a request let go of takes to close, and far shorter than a gate may take to answer. */
const LET_GO_MS = 5000;

/** Whether the silent gate's request is let go of within `ms`. */
async function letGoWithin(gate: SilentGate, ms: number): Promise<boolean> {
  const late = new Promise<boolean>((resolve) => {
    setTimeout(() => {
      resolve(false);
    }, ms).unref();
  });
  const letGo = (async (): Promise<boolean> => {
    await gate.letGo;
    return true;
  })();
  return Promise.race([letGo, late]);
}

/** What the Workers log, which nothing here reads. */
function ignore(): void {
  // Nothing asked to read it.
}

describe('a gate the Worker that asked it lets go of', () => {
  /**
   * The edge lets go of what it asked a gate where its visitor goes away or its deadline passes, and
   * the stack lets go of its own request to the gate with it — rather than hold it open for as long
   * as the gate takes, one for each request the edge gave up on.
   */
  it(
    'is let go of by the stack too',
    async () => {
      const gate = await startSilentGate();
      const asker = {
        name: 'asker',
        modules: [{ name: 'index.mjs', type: 'ESModule' as const, contents: ASKER }],
        compatibilityDate: '2026-09-15',
        handlers: gateServices({ [GATE]: { url: gate.url } }),
        socket: {},
      };
      const running = await runWorkers([asker], ignore);
      try {
        const answer = await fetch(await running.url('asker'));

        await expect(answer.text()).resolves.toBe('TimeoutError');
        await expect(letGoWithin(gate, LET_GO_MS)).resolves.toBe(true);
      } finally {
        await running.dispose();
        await gate.close();
      }
    },
    START_MS,
  );
});

/** A Worker that asks its gate, as the edge does, and answers with the bytes the gate answered. */
const READER = `
export default {
  async fetch(request, env) {
    const answer = await env.GATE__CHECKER.fetch('https://site.example/gated');
    return new Response(await answer.arrayBuffer(), {
      headers: { 'content-type': answer.headers.get('content-type') ?? '' },
    });
  },
};
`;

describe('a shell a gate answers a stack’s Worker with', () => {
  /**
   * Its bytes reach the Worker that asked as the gate sent them — the state a resume reads among
   * them, which holds what no text does — through the binding Node answers and the loopback it
   * answers on.
   */
  it(
    'reaches the Worker byte for byte',
    async () => {
      const gate = await startGate();
      const postponed = Uint8Array.from({ length: 256 }, (_, index) => index);
      const fields = { status: 200, headers: {}, route: GATED, seq: 1, id: 'shell-1' };
      const shell = encodeGateShell(fields, Buffer.from('<!DOCTYPE html><main>…'), postponed);
      gate.answer = () => {
        return {
          status: 200,
          headers: { [GATE_ANSWER_HEADER]: GATE_SHELL, 'content-type': GATE_SHELL_CONTENT_TYPE },
          body: Buffer.from(shell),
        };
      };
      const reader = {
        name: 'reader',
        modules: [{ name: 'index.mjs', type: 'ESModule' as const, contents: READER }],
        compatibilityDate: '2026-09-15',
        handlers: gateServices({ [GATE]: { url: gate.url.href } }),
        socket: {},
      };
      const running = await runWorkers([reader], ignore);
      try {
        const answer = await fetch(await running.url('reader'));

        expect(answer.headers.get('content-type')).toBe(GATE_SHELL_CONTENT_TYPE);
        expect(new Uint8Array(await answer.arrayBuffer())).toStrictEqual(shell);
      } finally {
        await running.dispose();
        await gate.close();
      }
    },
    START_MS,
  );
});

/** The deployment's one Function: what it was asked, by path. */
const APP = `
export default {
  fetch(request) {
    return Response.json({ from: 'the Function', path: new URL(request.url).pathname });
  },
};
`;

/** A build of one route with a gate, its Function answering every request. */
async function writeBundle(dir: string): Promise<void> {
  const bundleDir = path.join(dir, OUT_DIR_NAME);
  const blobs = path.join(bundleDir, 'blobs');
  await mkdir(blobs, { recursive: true });
  const bytes = Buffer.from(APP);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(blobs, sha256), bytes);
  const blob: BlobRef = { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript' };
  const bundle: DeploymentBundle = {
    v: 1,
    deploymentId: createId('dpl'),
    // A release a deploy accepts (`nextVersionSupported`).
    nextVersion: '16.2.4',
    buildId: 'test',
    projectDir: '.',
    generatedAt: new Date().toISOString(),
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: true,
      poweredByHeader: false,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'rsc',
        varyHeader: 'rsc',
        prefetchHeader: 'next-router-prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: 'text/x-component',
        suffix: '.rsc',
        prefetchSegmentHeader: 'next-router-segment-prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: [
      { id: GATED, kind: 'app-page', pathname: GATED },
      { id: '/open', kind: 'app-page', pathname: '/open' },
    ],
    gates: { [GATED]: GATE },
    prerenders: [],
    staticFiles: [],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [{ name: 'index.mjs', type: 'esm', blob }],
        compatibilityDate: '2026-09-15',
        compatibilityFlags: [],
      },
    },
  };
  await writeFile(path.join(bundleDir, 'bundle.json'), JSON.stringify(bundle));
}

describe('configured gate names', () => {
  it(
    'refuses a gate no loaded build declares before starting workers',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'upwind-local-gate-name-'));
      await writeBundle(dir);
      let stack: LocalStack | undefined;
      try {
        const starting = async (): Promise<void> => {
          stack = await startStack({
            bundleDir: path.join(dir, OUT_DIR_NAME),
            gates: { chekcer: { url: 'http://127.0.0.1:1/gate' } },
          });
        };

        await expect(starting()).rejects.toThrow(
          'the gate chekcer is not declared by the loaded build',
        );
      } finally {
        await stack?.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
    START_MS,
  );
});

describe('a stack whose build declares a gate', () => {
  const state: { dir?: string; gate?: Gate; stack?: LocalStack } = {};

  function started(): { readonly gate: Gate; readonly stack: LocalStack } {
    if (state.gate === undefined || state.stack === undefined) {
      throw new Error('the stack did not start');
    }
    return { gate: state.gate, stack: state.stack };
  }

  beforeAll(async () => {
    state.dir = await mkdtemp(path.join(tmpdir(), 'upwind-local-gates-'));
    await writeBundle(state.dir);
    state.gate = await startGate();
    state.stack = await startStack({
      bundleDir: path.join(state.dir, OUT_DIR_NAME),
      gates: { [GATE]: { url: state.gate.url.href, headers: CREDENTIAL } },
    });
  }, START_MS);

  afterAll(async () => {
    await state.stack?.dispose();
    await state.gate?.close();
    if (state.dir !== undefined) {
      await rm(state.dir, { recursive: true, force: true });
    }
  });

  it('asks the gate first, under the origin the visitor used, and serves on where it says to', async () => {
    const { gate, stack } = started();
    gate.answer = passing;
    const visited = new URL('/gated?tab=open', stack.url);

    const answer = await fetch(visited);
    const seen = gate.asked.at(-1);

    expect(answer.status).toBe(200);
    await expect(answer.json()).resolves.toStrictEqual({ from: 'the Function', path: GATED });
    expect(seen?.method).toBe('GET');
    expect(seen?.headers[GATE_ROUTE_HEADER]).toBe(GATED);
    expect(seen?.headers[GATE_URL_HEADER]).toBe(visited.href);
    expect(seen?.headers.authorization).toBe(CREDENTIAL.authorization);
  });

  it('answers with what the gate answers otherwise, kept nowhere', async () => {
    const { gate, stack } = started();
    gate.answer = () => ({ status: 403, body: 'revoked' });

    const refused = await fetch(new URL(GATED, stack.url));
    const refusal = await refused.text();
    gate.answer = passing;
    const served = await fetch(new URL(GATED, stack.url));
    await served.arrayBuffer();

    expect(refused.status).toBe(403);
    expect(refusal).toBe('revoked');
    expect(refused.headers.get('cache-control')).toBe('private, no-store');
    expect(refused.headers.get(EDGE_DEBUG_HEADER)).toBe(`gate;name=${GATE}`);
    expect(served.status).toBe(200);
  });

  it.each([403, 503])(
    'serves a real compressed gate %s after removing a reflected local failure marker',
    async (status) => {
      const { gate, stack } = started();
      const body = `remote:${String(status)}`;
      const bytes = gzipSync(body);
      gate.answer = () => {
        return {
          status,
          headers: {
            'content-encoding': 'gzip',
            'content-length': String(bytes.byteLength),
            [GATE_UNREACHABLE_HEADER]: 'a reflected visitor field',
            'x-remote': 'answered',
          },
          body: bytes,
        };
      };

      const answer = await fetch(new URL(GATED, stack.url));
      const received = await answer.text();

      expect(answer.status).toBe(status);
      expect(answer.headers.get('x-remote')).toBe('answered');
      expect(answer.headers.has(GATE_UNREACHABLE_HEADER)).toBe(false);
      expect(answer.headers.get(EDGE_DEBUG_HEADER)).toBe(`gate;name=${GATE}`);
      expect(received).toBe(body);
    },
  );

  it('serves a real gate HEAD with its representation headers and no failure marker', async () => {
    const { gate, stack } = started();
    const bytes = gzipSync('remote HEAD');
    gate.answer = () => {
      return {
        status: 503,
        headers: {
          'content-encoding': 'gzip',
          'content-length': String(bytes.byteLength),
          [GATE_UNREACHABLE_HEADER]: 'a reflected visitor field',
          'x-remote': 'answered',
        },
      };
    };

    const answer = await fetch(new URL(GATED, stack.url), { method: 'HEAD' });

    expect(answer.status).toBe(503);
    expect(answer.body).toBeNull();
    expect(answer.headers.get('content-encoding')).toBe('gzip');
    expect(answer.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(answer.headers.get('x-remote')).toBe('answered');
    expect(answer.headers.has(GATE_UNREACHABLE_HEADER)).toBe(false);
    expect(answer.headers.get(EDGE_DEBUG_HEADER)).toBe(`gate;name=${GATE}`);
  });

  it('asks no gate about a route it declared none for', async () => {
    const { gate, stack } = started();
    const before = gate.asked.length;

    const answer = await fetch(new URL('/open', stack.url));

    await expect(answer.json()).resolves.toStrictEqual({ from: 'the Function', path: '/open' });
    expect(gate.asked).toHaveLength(before);
  });
});

describe('a stack whose gate cannot be reached', () => {
  const state: { dir?: string; stack?: LocalStack } = {};

  function started(): LocalStack {
    if (state.stack === undefined) {
      throw new Error('the stack did not start');
    }
    return state.stack;
  }

  beforeAll(async () => {
    state.dir = await mkdtemp(path.join(tmpdir(), 'upwind-local-gates-'));
    await writeBundle(state.dir);
    state.stack = await startStack({
      bundleDir: path.join(state.dir, OUT_DIR_NAME),
      gates: { [GATE]: { url: await closedPort() } },
    });
  }, START_MS);

  afterAll(async () => {
    await state.stack?.dispose();
    if (state.dir !== undefined) {
      await rm(state.dir, { recursive: true, force: true });
    }
  });

  /** As a deployed edge whose gate cannot answer: unavailable, never served as though it had none. */
  it('answers that the gate is unavailable', async () => {
    const answer = await fetch(new URL(GATED, started().url));
    await answer.arrayBuffer();

    expect(answer.status).toBe(503);
    expect(answer.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-unavailable');
  });
});
