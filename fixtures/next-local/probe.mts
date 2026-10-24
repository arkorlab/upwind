/**
 * What `local:check` leaves unasked of this fixture, asked through the edge of a local stack: the
 * route handlers, the middleware's own answers, and a revalidation followed by a read of the page
 * it names. The check asks every page and file the build prerendered, and each Function only for a
 * pathname nothing serves; what this app renders on request is asked here.
 *
 *   npm run build:local && node probe.mts   (in fixtures/next-local)
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStack } from '../../packages/local/src/index.ts';

/**
 * How long a page may take to be kept, or to show what was revalidated: well inside the posts'
 * lifetimes (`app/posts/[slug]/page.tsx`), so that only a revalidation shows a new version.
 */
const WAIT_MS = 30_000;
const POLL_MS = 500;

const stack = await startStack({
  bundleDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '.arkor'),
  // The stores `app/api/resources` and the middleware bind, each empty.
  storage: { kv: ['CACHE'], r2: ['UPLOADS'], d1: ['DB'] },
  log: (message) => {
    console.error(message);
  },
});

function ask(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(pathname, stack.url), { redirect: 'manual', ...init });
}

interface Echoed {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | null>>;
  readonly body: string;
  readonly instrumented: number;
}

interface ResourcesSeen {
  readonly resources: readonly (readonly [string, string])[];
  readonly frozen: boolean;
  readonly kv: string | null;
  readonly r2: string | null;
  readonly d1: number | null;
}

/** A 200's JSON body, as the handler that answered it writes it. */
async function json<T>(response: Response): Promise<T> {
  assert.equal(response.status, 200, `status ${String(response.status)}`);
  return (await response.json()) as T;
}

/** The version a post's page shows, and which render it is (`lib/db.ts`). */
async function postShown(slug: string): Promise<{ version: number; render: number }> {
  const response = await ask(`/posts/${slug}`);
  assert.equal(response.status, 200, `status ${String(response.status)}`);
  const body = await response.text();
  const shown = new RegExp(String.raw`post=${slug} v=(\d+) r=(\d+)`).exec(body);
  assert.ok(shown, `no post=${slug} in the page`);
  return { version: Number(shown[1]), render: Number(shown[2]) };
}

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

/**
 * Asks the post again until it shows `version`, as a revalidation has the next renders show: no
 * read is begun after the deadline.
 */
async function waitForVersion(slug: string, version: number): Promise<void> {
  const until = performance.now() + WAIT_MS;
  for (;;) {
    const shown = await postShown(slug);
    if (shown.version === version) {
      return;
    }
    await pause();
    assert.ok(
      performance.now() < until,
      `still v=${String(shown.version)}, not v=${String(version)}, after ${String(WAIT_MS)} ms`,
    );
  }
}

const probes: Record<string, () => Promise<void>> = {
  'GET /api/echo': async () => {
    const response = await ask('/api/echo?header=x-probe&header=x-proxied', {
      headers: { 'x-probe': 'asked' },
    });
    assert.equal(response.headers.get('x-echo'), '1');
    assert.match(response.headers.get('set-cookie') ?? '', /echoed=1/);
    assert.equal(response.headers.get('x-from-proxy'), '1');
    const echoed = await json<Echoed>(response);
    assert.equal(echoed.method, 'GET');
    assert.equal(echoed.path, '/api/echo');
    // What the request named, and what the middleware set on it on the way.
    assert.deepEqual(echoed.headers, { 'x-probe': 'asked', 'x-proxied': '1' });
    // `instrumentation.ts`, registered once before the first request.
    assert.equal(echoed.instrumented, 1);
  },
  'POST /api/echo': async () => {
    const echoed = await json<Echoed>(await ask('/api/echo', { method: 'POST', body: 'posted' }));
    assert.equal(echoed.method, 'POST');
    assert.equal(echoed.body, 'posted');
  },
  'GET /api/wasm': async () => {
    assert.deepEqual(await json<unknown>(await ask('/api/wasm?input=41')), {
      input: 41,
      value: 42,
      eager: 42,
    });
  },
  'GET /api/wasm-module': async () => {
    assert.deepEqual(await json<unknown>(await ask('/api/wasm-module?input=41')), {
      input: 41,
      value: 42,
    });
  },
  'GET /api/lazy, then GET /': async () => {
    // A module loaded on demand, read whole before the next request is sent: the render after it
    // is the one that meets what the import left behind in the isolate (`app/api/lazy/route.ts`).
    assert.deepEqual(await json<unknown>(await ask('/api/lazy')), {
      from: 'a module loaded on demand',
    });
    const after = await ask('/');
    assert.equal(after.status, 200);
    assert.match(await after.text(), /id="shell"/);
  },
  'GET /api/boom': async () => {
    const response = await ask('/api/boom');
    await response.body?.cancel();
    assert.equal(response.status, 500);
  },
  'GET /api/resources': async () => {
    const seen = await json<ResourcesSeen>(await ask('/api/resources'));
    assert.deepEqual(
      new Set(seen.resources),
      new Set([
        ['CACHE', 'kv_namespace'],
        ['UPLOADS', 'r2_bucket'],
        ['DB', 'd1'],
      ]),
    );
    assert.equal(seen.frozen, true);
    assert.equal(seen.kv, 'from kv');
    assert.equal(seen.r2, 'from r2');
    assert.equal(seen.d1, 2);
  },
  'GET /resources-mw': async () => {
    const seen = await json<{ resources: string[]; kv: string | null }>(await ask('/resources-mw'));
    assert.deepEqual(new Set(seen.resources), new Set(['CACHE', 'UPLOADS', 'DB']));
    assert.equal(seen.kv, 'seen');
  },
  'GET /old': async () => {
    const response = await ask('/old');
    await response.body?.cancel();
    assert.equal(response.status, 308);
    assert.equal(new URL(response.headers.get('location') ?? '', stack.url).pathname, '/static');
  },
  'GET /home': async () => {
    const response = await ask('/home');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /fixture home/);
  },
  'GET /posts/second': async () => {
    // A member the build did not know: rendered on demand, then kept, so that asked again it is
    // the same render. What it rendered may reach the cache after its answer: asked until it has.
    const until = performance.now() + WAIT_MS;
    let last = await postShown('second');
    for (;;) {
      const next = await postShown('second');
      if (next.render === last.render) {
        return;
      }
      last = next;
      await pause();
      assert.ok(performance.now() < until, `rendered again on each read, r=${String(next.render)}`);
    }
  },
  'revalidateTag, then GET /posts/first': async () => {
    await postShown('first');
    const revalidated = await json<{ version: number }>(
      await ask('/api/revalidate?tag=post:first&mode=now', { method: 'POST' }),
    );
    await waitForVersion('first', revalidated.version);
  },
  'revalidatePath, then GET /posts/second': async () => {
    await postShown('second');
    const revalidated = await json<{ version: number }>(
      await ask('/api/revalidate?path=/posts/second', { method: 'POST' }),
    );
    await waitForVersion('second', revalidated.version);
  },
};

let failed = 0;
try {
  for (const [name, probe] of Object.entries(probes)) {
    try {
      await probe();
      console.log(`ok ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await stack.dispose();
}
console.log(
  `${stack.deploymentId}: ${String(Object.keys(probes).length - failed)} of ${String(Object.keys(probes).length)} probes answered`,
);
process.exitCode = failed === 0 ? 0 : 1;
