import { createServer, type Server } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownVersion } from '../../src/manifest.ts';
import type { PreviewOptions } from '../../src/preview/args.ts';
import { runPreview } from '../../src/preview/command.ts';
import {
  bundleOf,
  CACHE_HOST_SOURCE,
  functionOf,
  moduleOf,
  projectDir,
  writeBundle,
} from '../deploy/bundle.ts';
import { projectWith } from '../deploy/project.ts';

/**
 * `upwind preview` on a real stack: a build of one Function, served from this repository's sources
 * — which bundle the stack's Workers as the stack starts, as a published command ships them —
 * asked over HTTP, and stopped.
 */

const ANSWER = 'answered by the preview';
const SERVE_MS = 120_000;

/** What a Function answers every request with, unless the test gives it a handler of its own. */
const ANSWERING = `fetch() { return new Response(${JSON.stringify(ANSWER)}); }`;

/**
 * A project with a build of one Function, the cache host in it: answering every request, or as the
 * handler given does, and configured as the test says.
 */
async function builtProject(handler = ANSWERING, config?: unknown): Promise<string> {
  const dir = projectDir();
  projectWith({ dir, adapterVersion: await ownVersion(), config });
  const source = `${CACHE_HOST_SOURCE}\nexport default { ${handler} };`;
  const main = moduleOf(dir, 'index.mjs', 'esm', source);
  writeBundle(dir, bundleOf(functionOf([main])));
  return dir;
}

function optionsFor(dir: string, port = 0): PreviewOptions {
  return { projectDir: dir, port, envFiles: [], check: false };
}

/** The site asked once it serves: what it answered, and where. */
async function askedOnce(
  served: Promise<URL>,
): Promise<{ site: URL; status: number; body: string }> {
  const site = await served;
  const response = await fetch(site);
  return { site, status: response.status, body: await response.text() };
}

describe('`upwind preview`', () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((text: string) => {
      errors.push(text);
    });
    vi.spyOn(console, 'log').mockImplementation(vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'serves the build until it is stopped, and lets the stack go then',
    async () => {
      const dir = await builtProject();
      const served = Promise.withResolvers<URL>();
      const asked = askedOnce(served.promise);

      await expect(
        runPreview(optionsFor(dir), {
          stopped: asked,
          serving: (stack) => {
            served.resolve(stack.url);
          },
        }),
      ).resolves.toBe(0);

      const { site, status, body } = await asked;

      expect([status, body]).toStrictEqual([200, ANSWER]);
      await expect(fetch(site)).rejects.toThrow('fetch failed');
    },
    SERVE_MS,
  );

  it(
    "binds the storage deploy.storage names, each a store of the preview's own",
    async () => {
      // A query the database answers, and a write the namespace reads back.
      const handler = `async fetch(request, env) {
        const row = await env.ORDERS.prepare('select 41 + 1 as answer').first();
        await env.SESSIONS.put('seen', 'yes');
        return new Response(String(row.answer) + ' ' + (await env.SESSIONS.get('seen')));
      }`;
      const dir = await builtProject(handler, {
        file: undefined,
        deploy: { storage: { ORDERS: 'd1', SESSIONS: 'kv' } },
      });
      const served = Promise.withResolvers<URL>();
      const asked = askedOnce(served.promise);

      await expect(
        runPreview(optionsFor(dir), {
          stopped: asked,
          serving: (stack) => {
            served.resolve(stack.url);
          },
        }),
      ).resolves.toBe(0);

      await expect(asked).resolves.toMatchObject({ status: 200, body: '42 yes' });
    },
    SERVE_MS,
  );

  it('says to build first where the project has no build', async () => {
    const dir = projectDir();
    projectWith({ dir, adapterVersion: await ownVersion() });

    await expect(runPreview(optionsFor(dir))).resolves.toBe(1);
    expect(errors.join('\n')).toMatch(/build the project first, with `upwind build`/u);
  });

  describe('on a port something answers on already', () => {
    let server: Server;

    beforeEach(async () => {
      server = createServer();
      await new Promise<void>((resolve) => {
        server.listen(0, 'localhost', resolve);
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    });

    it('stops before it starts a stack', async () => {
      const dir = await builtProject();
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;

      await expect(runPreview(optionsFor(dir, port))).resolves.toBe(1);
      expect(errors.join('\n')).toContain(`answers on port ${String(port)} already`);
    });
  });
});
