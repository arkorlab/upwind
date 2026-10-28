import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BlobRef, DeploymentBundle } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { bundleStackScripts, type StackScripts, startStack } from '../src/stack.ts';

/**
 * A stack whose probed port is taken before it binds it. The probe lets the port go, and another
 * process may take it in between (`loopbackFor`). Named no port, the stack starts again on another;
 * named one, it fails as it did.
 */

const probing = vi.hoisted(() => ({ taken: [] as number[] }));

vi.mock(import('../src/ports.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loopbackFor: async (asked: number | undefined) => {
      const port = probing.taken.shift();
      return port === undefined ? actual.loopbackFor(asked) : { hosts: ['127.0.0.1'], port };
    },
  };
});

const START_MS = 60_000;
// The Function answers with the port it was told it listens on (`PORT`), so a retried start can
// be seen to have told it the port it bound rather than the one that was taken.
const APP = 'export default { fetch(request, env) { return new Response(env.PORT); } };';

async function writeBundle(dir: string): Promise<string> {
  const blobs = path.join(dir, '.arkor/blobs');
  const bundleDir = path.dirname(blobs);
  await mkdir(blobs, { recursive: true });
  const bytes = Buffer.from(APP);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(blobs, sha256), bytes);
  const blob: BlobRef = { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript' };
  const bundle: DeploymentBundle = {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'test',
    projectDir: '.',
    generatedAt: new Date().toISOString(),
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
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
    entrypoints: [{ id: '/', kind: 'app-page', pathname: '/' }],
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
  return bundleDir;
}

/** A port another process holds: a server listening on it until it is closed. */
async function occupied(): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  return server;
}

function portOf(server: net.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new TypeError('the server listens on no port');
  }
  return address.port;
}

describe('a stack whose probed port is taken before it binds it', () => {
  const state: { dir?: string; bundleDir?: string; scripts?: StackScripts } = {};
  const servers: net.Server[] = [];

  beforeAll(async () => {
    state.scripts = await bundleStackScripts();
    state.dir = await mkdtemp(path.join(tmpdir(), 'upwind-local-port-taken-'));
    state.bundleDir = await writeBundle(state.dir);
  }, START_MS);

  afterEach(async () => {
    probing.taken.length = 0;
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  afterAll(async () => {
    if (state.dir !== undefined) {
      await rm(state.dir, { recursive: true, force: true });
    }
  });

  async function taken(): Promise<number> {
    const server = await occupied();
    servers.push(server);
    const port = portOf(server);
    probing.taken.push(port);
    return port;
  }

  it(
    'starts on another port where it was named none',
    async () => {
      const port = await taken();
      const said: string[] = [];
      const stack = await startStack({
        bundleDir: state.bundleDir ?? '',
        scripts: state.scripts,
        port: 0,
        log: (message) => {
          said.push(message);
        },
      });
      try {
        const response = await fetch(stack.url);

        expect(new URL(stack.url).port).not.toBe(String(port));
        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe(new URL(stack.url).port);
        expect(said).toContain(
          `port ${String(port)} was taken before the stack bound it: starting on another`,
        );
      } finally {
        await stack.dispose();
      }
    },
    START_MS,
  );

  it(
    'fails as it did where it was named the port',
    async () => {
      const port = await taken();

      await expect(
        startStack({ bundleDir: state.bundleDir ?? '', scripts: state.scripts, port }),
      ).rejects.toMatchObject({ code: 'ERR_ADDRESS_IN_USE' });
    },
    START_MS,
  );

  it(
    'gives up after three ports taken in turn',
    async () => {
      await taken();
      await taken();
      await taken();

      await expect(
        startStack({ bundleDir: state.bundleDir ?? '', scripts: state.scripts }),
      ).rejects.toMatchObject({ code: 'ERR_ADDRESS_IN_USE' });
      expect(probing.taken).toHaveLength(0);
    },
    START_MS,
  );
});
