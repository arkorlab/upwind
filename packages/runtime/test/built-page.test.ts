import type { Prerender } from '@stayingupwind/core/bundle';
import { describe, expect, it, vi } from 'vitest';

import { builtPageResponse } from '../src/built-page.ts';
import { bundleBlobReader, type BundleBlobReader } from '../src/bundle-blobs.ts';
import { HTML_CONTENT_TYPE, type RoutedInput, RSC_CONTENT_TYPE } from '../src/serve.ts';
import { hasBundleBlob, type Store } from '../src/store.ts';

vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));
vi.mock(import('../src/store.ts'), () => ({ hasBundleBlob: vi.fn() }));

const BYTES = new TextEncoder().encode('BUILD-A');
const DOCUMENT: Prerender = {
  id: 'html',
  pathname: '/page',
  route: '/page',
  parentOutputId: 'page-entry',
  groupId: 1,
  routeType: 'page',
  response: 'complete',
  compute: 'static',
  body: { sha256: 'a'.repeat(64), byteLength: BYTES.byteLength, contentType: HTML_CONTENT_TYPE },
  initialHeaders: { link: '</style.css>; rel=preload', 'x-build': 'A' },
};
const TWIN: Prerender = {
  id: 'rsc',
  pathname: '/page.rsc',
  route: DOCUMENT.route,
  parentOutputId: DOCUMENT.parentOutputId,
  groupId: 1,
  body: { sha256: 'b'.repeat(64), byteLength: BYTES.byteLength, contentType: RSC_CONTENT_TYPE },
  initialHeaders: DOCUMENT.initialHeaders,
};

function unavailableHost(): Promise<never> {
  return Promise.reject(new Error('host unavailable'));
}

function absent(): never {
  throw Object.assign(new Error('missing from virtual bundle'), { code: 'ENOENT' });
}

function fixture(
  input: {
    readonly shipped?: boolean;
    readonly method?: string;
    readonly blobs?: BundleBlobReader | undefined;
  } = {},
) {
  vi.mocked(hasBundleBlob)
    .mockReset()
    .mockReturnValue(input.shipped === true);
  const readBlob = vi.fn(input.shipped === true ? () => BYTES : absent);
  const blobs = vi.fn(input.blobs ?? (() => Promise.resolve(BYTES)));
  const routed = {
    request: new Request('https://app.test/page', { method: input.method ?? 'GET' }),
    blobs,
  } as unknown as RoutedInput;
  const store = {
    manifest: {
      config: { basePath: '' },
      entrypoints: [{ id: 'page-entry', pathname: '/page', kind: 'app-page' }],
      routing: { rsc: { suffix: '.rsc', varyHeader: 'rsc, next-router-state-tree' } },
    },
    readBlob,
  } as unknown as Store;
  const answer = (
    prerender = DOCUMENT,
    how: { status?: number; allowHost?: boolean; document?: Prerender } = {},
  ) => {
    return builtPageResponse(routed, store, prerender, {
      document: how.document ?? DOCUMENT,
      contentType: prerender.id === TWIN.id ? RSC_CONTENT_TYPE : HTML_CONTENT_TYPE,
      status: how.status ?? 200,
      allowHost: how.allowHost ?? true,
    });
  };
  return { answer, blobs, readBlob, store };
}

describe.each([DOCUMENT, TWIN])('completed built output $id', (prerender) => {
  it('keeps shipped bytes synchronous and makes no host call', async () => {
    const test = fixture({ shipped: true });
    Object.defineProperty(test.store.manifest, 'entrypoints', {
      get() {
        throw new Error('Shipped bytes must not scan route eligibility');
      },
    });
    const result = test.answer(prerender);

    expect(result).toBeInstanceOf(Response);
    await expect((await result).text()).resolves.toBe('BUILD-A');
    expect(test.blobs).not.toHaveBeenCalled();
    expect(test.readBlob).toHaveBeenCalledExactlyOnceWith(prerender.body?.sha256);
  });

  it('reads the exact missing immutable body with its known byte length', async () => {
    const test = fixture();
    const result = await test.answer(prerender);

    await expect(result.text()).resolves.toBe('BUILD-A');
    expect(test.blobs).toHaveBeenCalledExactlyOnceWith(prerender.body?.sha256, BYTES.byteLength);
    expect(result.status).toBe(200);
    expect(result.headers.get('x-nextjs-cache')).toBe('HIT');
    expect(result.headers.get('x-build')).toBe('A');
  });

  it('preserves representation headers on a hosted body', async () => {
    const test = fixture();
    const result = await test.answer(prerender);

    expect(result.headers.get('content-type')).toBe(prerender.body?.contentType);
    expect(result.headers.get('link')).toBe(
      prerender.id === TWIN.id ? null : DOCUMENT.initialHeaders?.['link'],
    );
  });

  it('answers shipped HEAD without a configured reader or reading body bytes', () => {
    const test = fixture({ method: 'HEAD', shipped: true });
    const input = {
      request: new Request('https://app.test/page', { method: 'HEAD' }),
    } as RoutedInput;
    const response = builtPageResponse(input, test.store, prerender, {
      document: DOCUMENT,
      contentType: prerender.id === TWIN.id ? RSC_CONTENT_TYPE : HTML_CONTENT_TYPE,
      status: 200,
      allowHost: true,
    });

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(200);
    expect(vi.mocked(hasBundleBlob)).toHaveBeenCalledExactlyOnceWith(prerender.body?.sha256);
    expect(test.readBlob).not.toHaveBeenCalled();
    expect(test.blobs).not.toHaveBeenCalled();
  });

  it('rejects HEAD without a local body or reader before reporting HIT', () => {
    const test = fixture({ method: 'HEAD' });
    const input = {
      request: new Request('https://app.test/page', { method: 'HEAD' }),
    } as RoutedInput;

    expect(() => {
      return builtPageResponse(input, test.store, prerender, {
        document: DOCUMENT,
        contentType: prerender.id === TWIN.id ? RSC_CONTENT_TYPE : HTML_CONTENT_TYPE,
        status: 200,
        allowHost: true,
      });
    }).toThrow('required built page body is unavailable');
    expect(vi.mocked(hasBundleBlob)).toHaveBeenCalledExactlyOnceWith(prerender.body?.sha256);
    expect(test.readBlob).not.toHaveBeenCalled();
    expect(test.blobs).not.toHaveBeenCalled();
  });

  it('answers HEAD with no body lookup or host call', async () => {
    const test = fixture({ method: 'HEAD' });
    const result = await test.answer(prerender);

    expect(result.body).toBeNull();
    expect(result.status).toBe(200);
    expect(test.blobs).not.toHaveBeenCalled();
    expect(test.readBlob).not.toHaveBeenCalled();
  });
});

describe('required built body failure boundaries', () => {
  it('keeps whole Flight responses private and varies them by the client router headers', async () => {
    const test = fixture();
    const response = await test.answer(TWIN);

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('rsc, next-router-state-tree');
  });

  it.each([
    { reason: 'missing', value: undefined },
    { reason: 'truncated', value: BYTES.subarray(0, BYTES.byteLength - 1) },
    { reason: 'oversized', value: new Uint8Array(BYTES.byteLength + 1) },
  ])('fails instead of rendering or reporting HIT for a $reason body', async ({ value }) => {
    const test = fixture({ blobs: () => Promise.resolve(value) });

    await expect(test.answer()).rejects.toThrow('required built page body');
    expect(test.blobs).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when no reader was provided', async () => {
    const test = fixture();
    const routed = { request: new Request('https://app.test/page') } as RoutedInput;

    await expect(
      builtPageResponse(routed, test.store, DOCUMENT, {
        document: DOCUMENT,
        contentType: HTML_CONTENT_TYPE,
        status: 200,
        allowHost: true,
      }),
    ).rejects.toThrow('required built page body');
  });

  it('turns a rejected host read into a required-body failure through the existing wrapper', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(vi.fn());
    const blobs = bundleBlobReader(() => unavailableHost, {
      env: undefined,
    });
    const test = fixture({ blobs });

    await expect(test.answer()).rejects.toThrow('required built page body');
    expect(log).toHaveBeenCalledTimes(1);

    log.mockRestore();
  });

  it('waits for the required bytes before producing a HIT response', async () => {
    const pending = Promise.withResolvers<Uint8Array | undefined>();
    const test = fixture({ blobs: () => pending.promise });
    const result = test.answer();
    let hasAnswer = false;
    async function observe(): Promise<Response> {
      const response = await result;
      hasAnswer = true;
      return response;
    }
    const settled = observe();
    await Promise.resolve();

    expect(hasAnswer).toBe(false);

    pending.resolve(BYTES);

    expect((await settled).headers.get('x-nextjs-cache')).toBe('HIT');
  });

  it('preserves non-missing VFS errors without invoking a host reader', () => {
    const test = fixture();
    const denied = Object.assign(new Error('VFS denied'), { code: 'EACCES' });

    test.readBlob.mockImplementation(() => {
      throw denied;
    });

    expect(() => test.answer()).toThrow(denied);
    expect(test.blobs).not.toHaveBeenCalled();
  });

  it('preserves a refused or class-shell missing-body failure without a host read', () => {
    const test = fixture();

    expect(() => test.answer(DOCUMENT, { allowHost: false })).toThrow(
      'missing from virtual bundle',
    );
    expect(() => test.answer(DOCUMENT, { document: { ...DOCUMENT, routeType: 'shell' } })).toThrow(
      'missing from virtual bundle',
    );
    expect(test.blobs).not.toHaveBeenCalled();
  });

  it.each([204, 205, 304])('keeps status %s bodyless without a host read', async (status) => {
    const test = fixture();
    const response = await test.answer(DOCUMENT, { status });

    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(test.readBlob).not.toHaveBeenCalled();
    expect(test.blobs).not.toHaveBeenCalled();
  });

  it.each([204, 205, 304])(
    'keeps HEAD status %s bodyless with no metadata lookup or reader',
    (status) => {
      const test = fixture({ method: 'HEAD' });
      const input = {
        request: new Request('https://app.test/page', { method: 'HEAD' }),
      } as RoutedInput;
      const response = builtPageResponse(input, test.store, DOCUMENT, {
        document: DOCUMENT,
        contentType: HTML_CONTENT_TYPE,
        status,
        allowHost: true,
      });

      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(status);
      expect(vi.mocked(hasBundleBlob)).not.toHaveBeenCalled();
      expect(test.readBlob).not.toHaveBeenCalled();
      expect(test.blobs).not.toHaveBeenCalled();
    },
  );

  it('forwards the optional size while remaining compatible with a digest-only reader', async () => {
    const reader: BundleBlobReader = (sha256) =>
      Promise.resolve(sha256 === DOCUMENT.body?.sha256 ? BYTES : undefined);
    const test = fixture({ blobs: bundleBlobReader(() => reader, { env: undefined }) });

    await expect((await test.answer()).text()).resolves.toBe('BUILD-A');
  });
});
