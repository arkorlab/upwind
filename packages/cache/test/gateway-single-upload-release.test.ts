import { encodeUtf8, sha256Hex } from '@stayingupwind/core/util';
import type { ArtifactUpload, FetchLike } from '@stayingupwind/runtime/cache-host';
import { describe, expect, it, vi } from 'vitest';

import { Gateway } from '../src/function/gateway.ts';

const BYTES = encodeUtf8('the uploaded artifact');
const UPLOAD: ArtifactUpload = {
  attemptId: 'attempt',
  fencingToken: 1,
  role: 'html',
  contentType: 'text/html',
  bytes: BYTES,
};

function gateway(response: Response): Gateway {
  const send = vi.fn<FetchLike>().mockResolvedValue(response);
  return new Gateway({
    scopeId: 'single_upload_cleanup',
    gatewayUrl: 'https://authority.example',
    token: 'scope-token',
    naming: { copyCache: 'upload-copies', copyKeyOrigin: 'https://copies.example' },
    fetchImpl: send,
  });
}

function responseWith(cancel: () => void | Promise<void>): Response {
  return new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 });
}

describe('a single artifact upload releases its unused success response', () => {
  it('cancels the body and returns the local artifact digest and length', async () => {
    const cancel = vi.fn();
    const subject = gateway(responseWith(cancel));
    const expected = { sha256: await sha256Hex(BYTES), byteLength: BYTES.byteLength };

    await expect(subject.uploadArtifact(UPLOAD)).resolves.toStrictEqual(expected);
    expect(cancel).toHaveBeenCalledExactlyOnceWith('the artifact upload response is not used');
  });

  it('does not wait for the cancellation acknowledgement', async () => {
    const cancelled = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cancelled.promise);
    const subject = gateway(responseWith(cancel));
    let completed = false;
    const result = subject.uploadArtifact(UPLOAD).then((value) => {
      completed = true;
      return value;
    });
    try {
      await vi.waitFor(() => {
        expect(completed).toBe(true);
      });
      await expect(result).resolves.toMatchObject({ byteLength: BYTES.byteLength });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      cancelled.resolve();
      await result;
    }
  });

  it('keeps a rejected cancellation from replacing the successful result', async () => {
    const cancel = vi.fn(() => Promise.reject(new Error('cancel failed')));
    const subject = gateway(responseWith(cancel));

    await expect(subject.uploadArtifact(UPLOAD)).resolves.toMatchObject({
      byteLength: BYTES.byteLength,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps the existing failure envelope handling', async () => {
    const subject = gateway(
      Response.json(
        { ok: false, error: { code: 'quota_exceeded', message: 'the scope is full' } },
        { status: 409 },
      ),
    );

    await expect(subject.uploadArtifact(UPLOAD)).rejects.toMatchObject({
      code: 'quota_exceeded',
      message: 'the scope is full',
    });
  });
});
