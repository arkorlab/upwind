import {
  FUNCTION_HEADER,
  INVALIDATED_REVISION_HEADER,
  INVALIDATED_TAGS_HEADER,
  ROUTED_HEADER,
} from '@stayingupwind/core/paas';
import { describe, expect, it, vi } from 'vitest';

import { InvalidatedTags, requestContext } from '../src/cache/context.ts';
import { handleRequestWith } from '../src/handle-context.ts';

describe('the shared request context and response finalization', () => {
  it('waits for invalidation receipts and removes application-supplied platform response headers', async () => {
    const receipt = Promise.withResolvers<undefined>();
    const routed = Promise.withResolvers<undefined>();
    const invalidated = new InvalidatedTags();
    const request = new Request('https://site.test/');
    const tables = { app: { entries: {} }, edge: { entries: {} } };
    const finished = vi.fn();
    async function finish() {
      const response = await handleRequestWith(
        { ...tables, request, invalidated, waitUntil: vi.fn() },
        () => {
          const context = requestContext();

          expect(context?.invalidated).toBe(invalidated);
          expect(context?.request).toBe(request);

          invalidated.hold(receipt.promise);
          routed.resolve(undefined);
          return Promise.resolve(
            new Response('body', {
              headers: {
                [FUNCTION_HEADER]: 'forged',
                [ROUTED_HEADER]: 'forged',
                [INVALIDATED_TAGS_HEADER]: 'forged',
                [INVALIDATED_REVISION_HEADER]: '999',
              },
            }),
          );
        },
      );
      finished();
      return response;
    }
    const answer = finish();
    await routed.promise;

    expect(finished).not.toHaveBeenCalled();

    invalidated.add(['changed'], 42);
    receipt.resolve(undefined);
    const response = await answer;

    expect(response.headers.has(FUNCTION_HEADER)).toBe(false);
    expect(response.headers.has(ROUTED_HEADER)).toBe(false);
    expect(response.headers.get(INVALIDATED_TAGS_HEADER)).toBe('changed');
    expect(response.headers.get(INVALIDATED_REVISION_HEADER)).toBe('42');
    await expect(response.text()).resolves.toBe('body');
  });

  it('releases a HEAD body without waiting for a stalled cancellation', async () => {
    const cancelled = vi.fn(() => Promise.withResolvers<undefined>().promise);
    const stream = new ReadableStream({ cancel: cancelled });
    const response = await handleRequestWith(
      {
        app: { entries: {} },
        edge: { entries: {} },
        request: new Request('https://site.test/', { method: 'HEAD' }),
        waitUntil: vi.fn(),
      },
      () => Promise.resolve(new Response(stream, { headers: { 'x-example': 'kept' } })),
    );

    expect(response.body).toBeNull();
    expect(response.headers.get('x-example')).toBe('kept');
    expect(cancelled).toHaveBeenCalledExactlyOnceWith('HEAD: body not sent');
  });
});
