import { afterEach, describe, expect, it, vi } from 'vitest';

import entry from '../src/function.ts';
import { handleRequest } from '../src/handle.ts';

/**
 * A request the Function fails before Next.js answers it — a middleware that throws, an
 * edge-runtime handler, a module that throws as it is evaluated — is answered with a 500 that says
 * nothing of why: the failure's own words go to the log, under a reference the answer carries too.
 */

vi.mock(import('../src/handle.ts'), () => ({ handleRequest: vi.fn() }));
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: vi.fn(),
    changesSomething: (method: string) => method !== 'GET' && method !== 'HEAD',
  };
});
// What the Function entry is bundled beside, which a suite of it does without (`capture-invoke`).
vi.mock(import('../src/environment.ts'), () => ({}));
vi.mock(import('../src/cache/install.ts'), () => ({}));
vi.mock(import('arkor:wasm'), () => ({}));
vi.mock(import('arkor:app'), () => ({ default: { entries: {} } }));
vi.mock(import('arkor:edge'), () => ({ default: { entries: {} } }));
vi.mock(import('arkor:cache-host'), () => {
  const none = vi.fn();
  return { createCacheHost: none, createBundleBlobReader: none };
});

const SAID = 'could not read /srv/app/.env.production: token=not-for-the-client';
const REFERENCE =
  /^Internal Server Error \((?<reference>[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\)$/u;

describe('a request the Function fails before Next.js answers it', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('answers 500 without the failure’s words, and logs them under the reference it answers with', async () => {
    const failure = new Error(SAID);
    vi.mocked(handleRequest).mockRejectedValueOnce(failure);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // Kept off the suite's output; read below.
    });

    const response = await entry.fetch(new Request('https://app.test/'), undefined, {
      waitUntil: () => {
        // Nothing is held for a GET.
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    const body = await response.text();
    const reference = REFERENCE.exec(body)?.groups?.['reference'];

    expect(body).not.toContain(SAID);
    expect(reference).toBeDefined();
    expect(logged).toHaveBeenCalledWith(
      `next-runtime: request failed (${String(reference)})`,
      failure,
    );
  });

  it('answers each failure under a reference of its own', async () => {
    vi.mocked(handleRequest).mockRejectedValue(new Error(SAID));
    vi.spyOn(console, 'error').mockImplementation(() => {
      // Kept off the suite's output.
    });
    const context = {
      waitUntil: () => {
        // Nothing is held for a GET.
      },
    };

    const first = await entry.fetch(new Request('https://app.test/'), undefined, context);
    const second = await entry.fetch(new Request('https://app.test/'), undefined, context);
    const [one, other] = [await first.text(), await second.text()].map(
      (body) => REFERENCE.exec(body)?.groups?.['reference'],
    );

    expect(one).toBeDefined();
    expect(other).toBeDefined();
    expect(one).not.toBe(other);
  });
});
