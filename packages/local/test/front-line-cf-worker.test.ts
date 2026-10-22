import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bundleWorker } from '../src/bundle.ts';
import { type RunningWorkers, runWorkers } from '../src/miniflare.ts';

/** Actual workerd contracts: run in CI, with all outbound requests bound to the receiver. */
const START_MS = 60_000;
const COMPATIBILITY_DATE = '2026-09-15';
const EXCLUSIVE = "The 'cacheControl' and 'cacheTtl' options on cf are mutually exclusive.";
const SENDER = `
export default {
  async fetch(request) {
    const mode = new URL(request.url).pathname.slice(1);
    const target = 'https://incoming-cf.invalid/';
    if (mode === 'explicit-conflict') {
      try {
        new Request(target, { cf: { cacheTtl: 60, cacheControl: 'max-age=60' } });
        return Response.json({ rejected: false });
      } catch (error) {
        return Response.json({ rejected: error instanceof TypeError, message: error.message });
      }
    }
    const options = mode === 'ttl'
      ? { cf: { cacheTtl: 60 } }
      : mode === 'private'
        ? { cf: { cacheControl: 'private, no-store' } }
        : { cache: mode };
    return fetch(target, options);
  },
};
`;

interface Observation {
  incoming: Record<string, unknown>;
  legacyError: string | null;
  legacyCf: Record<string, unknown> | null;
  handed: Record<string, unknown>;
  untouched: boolean;
}

describe('native incoming cf reconstruction', () => {
  let workers: RunningWorkers | undefined;
  let origin: URL;

  beforeAll(async () => {
    const receiver = await bundleWorker(
      fileURLToPath(new URL('fixtures/front-line-cf-worker.ts', import.meta.url)),
    );
    workers = await runWorkers(
      [
        {
          name: 'sender',
          compatibilityDate: COMPATIBILITY_DATE,
          modules: [{ type: 'ESModule', name: 'sender.mjs', contents: SENDER }],
          outbound: 'receiver',
          socket: {},
        },
        {
          name: 'receiver',
          compatibilityDate: COMPATIBILITY_DATE,
          modules: [
            {
              type: 'ESModule',
              name: 'receiver.mjs',
              contents: "import { receive } from './probe.mjs'; export default { fetch: receive };",
            },
            { type: 'ESModule', name: 'probe.mjs', contents: receiver.script },
          ],
        },
      ],
      () => {
        // No application logs are needed for these native request assertions.
      },
    );
    origin = await workers.url('sender');
  }, START_MS);

  afterAll(async () => {
    await workers?.dispose();
  });

  async function observed(mode: string): Promise<Observation> {
    const response = await fetch(new URL(mode, origin));

    expect(response.status).toBe(200);

    return (await response.json()) as Observation;
  }

  it.each([
    { mode: 'no-store', ttl: -1, control: 'no-store' },
    { mode: 'ttl', ttl: 60, control: 'max-age=60' },
  ])('accepts the runtime-generated $mode pair that the old clone rejected', async (each) => {
    const result = await observed(each.mode);

    expect(result.incoming).toMatchObject({ cacheTtl: each.ttl, cacheControl: each.control });
    expect(result.legacyError).toBe(
      `TypeError: ${EXCLUSIVE} Use 'cacheControl' for explicit Cache-Control header directives, or 'cacheTtl' for a simplified TTL, but not both.`,
    );
    expect(result.handed).toMatchObject({
      cacheControl: each.control,
      clientAcceptEncoding: 'identity',
    });
    expect(result.handed).not.toHaveProperty('cacheTtl');
    expect(result.untouched).toBe(true);
  });

  it('retains the no-store bypass flag', async () => {
    const result = await observed('no-store');

    expect(result.handed['cacheLevel']).toBe('bypass');
  });

  it.each([
    { mode: 'no-cache', control: 'no-cache' },
    { mode: 'private', control: 'private, no-store' },
  ])('preserves valid $mode directives', async (each) => {
    const result = await observed(each.mode);

    expect(result.incoming['cacheControl']).toBe(each.control);
    expect(result.legacyError).toBeNull();
    expect(result.legacyCf).toStrictEqual(result.handed);
    expect(result.handed).toStrictEqual({ ...result.incoming, clientAcceptEncoding: 'identity' });
    expect(result.untouched).toBe(true);
  });

  it('still rejects conflicting cf explicitly supplied by application code', async () => {
    const response = await fetch(new URL('explicit-conflict', origin));

    expect(response.status).toBe(200);

    const result: unknown = await response.json();

    expect(result).toMatchObject({
      rejected: true,
      message: expect.stringContaining(EXCLUSIVE) as unknown,
    });
  });
});
