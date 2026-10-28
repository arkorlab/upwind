import { describe, expect, it, vi } from 'vitest';

import { nodeOidcCapability } from '../src/node-oidc.ts';

const TOKEN = { ok: true, token: 'inert-application-token', expiresAt: 1_800_000_000_123 };

describe('node OIDC audience-only capability', () => {
  it('makes no request until called and preserves the token and epoch-millisecond expiration', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(TOKEN));
    const binding = nodeOidcCapability({ fetch });

    expect(fetch).not.toHaveBeenCalled();
    await expect(binding.token({ audience: 'api://AzureADTokenExchange' })).resolves.toStrictEqual(
      TOKEN,
    );

    const [input, init] = fetch.mock.calls[0]!;
    const request = new Request(input, init);

    expect({
      url: request.url,
      method: request.method,
      cache: request.cache,
      redirect: request.redirect,
      contentType: request.headers.get('content-type'),
    }).toStrictEqual({
      url: 'https://oidc.upwind.internal/v1/token',
      method: 'POST',
      cache: 'no-store',
      redirect: 'manual',
      contentType: 'application/json',
    });
    await expect(request.json()).resolves.toStrictEqual({ audience: 'api://AzureADTokenExchange' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses empty options for the issuer’s default audience', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(TOKEN));
    const binding = nodeOidcCapability({ fetch });

    await binding.token();

    const [input, init] = fetch.mock.calls[0]!;

    await expect(new Request(input, init).json()).resolves.toStrictEqual({});
  });

  it.each(['invalid_identity', 'invalid_audience', 'rate_limited', 'unavailable'])(
    'preserves issuer refusal %s without another fetch',
    async (reason) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ ok: false, reason }));

      await expect(nodeOidcCapability({ fetch }).token()).resolves.toStrictEqual({
        ok: false,
        reason,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('does not send customer identity or props fields to the broker', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const input = {
      audience: 'wanted',
      projectId: 'another-project',
      ownerId: 'another-team',
      props: {},
    };

    await expect(nodeOidcCapability({ fetch }).token(input)).resolves.toStrictEqual({
      ok: false,
      reason: 'invalid_audience',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['', 'a'.repeat(4096)])(
    'bounds invalid/oversized audience options before transport',
    async (audience) => {
      const fetch = vi.fn<typeof globalThis.fetch>();

      await expect(nodeOidcCapability({ fetch }).token({ audience })).resolves.toStrictEqual({
        ok: false,
        reason: 'invalid_audience',
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ok: true, token: 'inert', expiresAt: '1800000000123' },
    { ok: true, token: '', expiresAt: 1_800_000_000_123 },
    { ok: true, token: 'inert', expiresAt: 1.5 },
    { ok: false, reason: 'unknown-issuer-value' },
    { ok: false, reason: 'unavailable', identity: 'unexpected' },
  ])('rejects an unproved response shape without exposing its contents', async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(value));

    await expect(nodeOidcCapability({ fetch }).token()).rejects.toThrow(
      'invalid Node OIDC capability response',
    );
  });

  it('does not follow HTTP errors or include malformed response bodies in errors', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('private-body', { status: 302 }))
      .mockResolvedValueOnce(new Response('private-body'));
    const binding = nodeOidcCapability({ fetch });

    await expect(binding.token()).rejects.toThrow('Node OIDC capability unavailable');
    await expect(binding.token()).rejects.toThrow('invalid Node OIDC capability response');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cancels an oversized response while reading a bounded stream', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20_000));
      },
      cancel,
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));

    await expect(nodeOidcCapability({ fetch }).token()).rejects.toThrow(
      'invalid Node OIDC capability response',
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
