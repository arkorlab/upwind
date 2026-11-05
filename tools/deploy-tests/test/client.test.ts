import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, createClient } from '../src/client.ts';
import type { Config } from '../src/config.ts';

const config: Config = {
  baseUrl: 'https://api.example.test',
  projectId: 'prj_test',
  token: 'private-deploy-test-token',
  settleMs: 0,
};

function answer(body: unknown, status = 400): Response {
  return Response.json(body, { status });
}

async function refusal(request: Promise<unknown>): Promise<ApiError> {
  try {
    await request;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('the request did not return an API refusal');
}

describe('api refusal diagnostics', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the host reason beside the status and code without retrying a refusal', async () => {
    const reason = 'Native Function Containers currently require hosted Git builds only';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(answer({ error: { code: 'invalid_request', message: reason } }));
    vi.stubGlobal('fetch', fetch);

    const error = await refusal(createClient(config).getProject());

    expect(error).toMatchObject({
      name: 'ApiError',
      status: 400,
      code: 'invalid_request',
      message: `HTTP 400 (invalid_request): ${reason}`,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { body: 'not JSON', code: 'unknown' },
    { body: JSON.stringify(null), code: 'unknown' },
    { body: JSON.stringify([]), code: 'unknown' },
    { body: JSON.stringify({ error: [] }), code: 'unknown' },
    { body: JSON.stringify({ error: { code: 'invalid_request' } }), code: 'invalid_request' },
    {
      body: JSON.stringify({ error: { code: 'invalid_request', message: null } }),
      code: 'invalid_request',
    },
    {
      body: JSON.stringify({ error: { code: 'invalid_request', message: 42 } }),
      code: 'invalid_request',
    },
    {
      body: JSON.stringify({ error: { code: 'invalid_request', message: ' \n\0 ' } }),
      code: 'invalid_request',
    },
  ])('keeps the status/code fallback for $body', async ({ body, code }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 400 })),
    );

    const error = await refusal(createClient(config).getProject());

    expect(error).toMatchObject({ status: 400, code, message: `HTTP 400 (${code})` });
  });

  it('keeps a useful message when the host omitted a valid code', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(answer({ error: { code: 42, message: 'The artifact is invalid' } })),
    );

    const error = await refusal(createClient(config).getProject());

    expect(error).toMatchObject({
      status: 400,
      code: 'unknown',
      message: 'HTTP 400 (unknown): The artifact is invalid',
    });
  });

  it('redacts credentials in both the displayed code and reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          answer({ error: { code: config.token, message: `Do not display ${config.token}` } }),
        ),
    );

    const error = await refusal(createClient(config).getProject());

    expect(error.code).toBe(config.token);
    expect(error.message).toBe('HTTP 400 ([redacted]): Do not display [redacted]');
  });

  it('remembers sent secret environment values for later refusals and removes longer values first', async () => {
    const secret = 'private-environment-value';
    const longer = `${secret}-longer`;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(answer({}, 200))
      .mockResolvedValueOnce(
        answer({
          error: {
            code: 'invalid_request',
            message: `${longer} ${secret} ${config.token}`,
          },
        }),
      );
    vi.stubGlobal('fetch', fetch);
    const client = createClient(config);
    await client.putEnv([
      { name: 'FIRST', value: secret, secret: true },
      { name: 'SECOND', value: longer, secret: true },
      { name: 'KEPT', value: null, secret: true },
    ]);

    const error = await refusal(client.finalize('dpl_test'));

    expect(error.message).toBe('HTTP 400 (invalid_request): [redacted] [redacted] [redacted]');
  });

  it('redacts secret environment values when the PUT itself fails', async () => {
    const secret = 'private-environment-value';
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          answer({ error: { code: 'invalid_request', message: `Cannot accept ${secret}` } }),
        ),
    );

    const error = await refusal(
      createClient(config).putEnv([{ name: 'SECRET', value: secret, secret: true }]),
    );

    expect(error.message).toBe('HTTP 400 (invalid_request): Cannot accept [redacted]');
  });

  it('remembers a secret value returned by the host without hiding plain environment values', async () => {
    const secret = 'private-returned-value';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        answer(
          {
            env: [
              { name: 'SECRET', value: secret, secret: true },
              { name: 'PLAIN', value: 'plain-value', secret: false },
            ],
          },
          200,
        ),
      )
      .mockResolvedValueOnce(
        answer({
          error: {
            code: 'invalid_request',
            message: `${secret} plain-value`,
          },
        }),
      );
    vi.stubGlobal('fetch', fetch);
    const client = createClient(config);
    await client.getEnv();

    const error = await refusal(client.getProject());

    expect(error.message).toBe('HTTP 400 (invalid_request): [redacted] plain-value');
  });

  it('normalizes control characters and line breaks without changing the structured code', async () => {
    const code = 'invalid_request\n::warning::';
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        answer({
          error: { code, message: '  rejected\r\n\t::error::\0 details\u{2028} here  ' },
        }),
      ),
    );

    const error = await refusal(createClient(config).getProject());

    expect(error.code).toBe(code);
    expect(error.message).toBe(
      'HTTP 400 (invalid_request ::warning::): rejected ::error:: details here',
    );
  });

  it('redacts before truncating a long reason to one bounded log line', async () => {
    const padding = 'x'.repeat(2000);
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        answer({
          error: {
            code: 'invalid_request',
            message: `${padding} ${config.token} ${padding}`,
          },
        }),
      ),
    );

    const error = await refusal(createClient(config).getProject());

    expect(error.message).toHaveLength(2048);
    expect(error.message).toMatch(/^HTTP 400 \(invalid_request\): /u);
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain(config.token);
    expect(error.message).toMatch(/…$/u);
  });
});
