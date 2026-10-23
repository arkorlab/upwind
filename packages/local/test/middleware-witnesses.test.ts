import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { middlewareProbeVerdict } from '../src/middleware-probe.ts';
import { MIDDLEWARE_ACCOUNT_BYTES, probeReason } from '../src/workers/protocol.ts';

/** The real probe reader reaches this backstage only after its compiled matcher accepts a path. */
const observed: string[] = [];
/** What the backstage answers next: a broken middleware's account, but where a test says otherwise. */
const BROKEN = JSON.stringify({ kind: 'responded', status: 500 });
const replies: { next: string } = { next: BROKEN };
const server = createServer((request, response) => {
  const asked = new URL(request.url ?? '/', 'http://backstage.invalid');
  observed.push(asked.searchParams.get('path') ?? '');
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(replies.next);
  replies.next = BROKEN;
});

function stackFor(backstage: URL, source: string, sourceRegex: string): CheckedStack {
  // These are all the fields consumed by pathname selection and the real HTTP probe reader.
  return {
    site: new URL('https://site.invalid/'),
    backstage,
    bundle: { config: { basePath: '' }, middleware: { matchers: [{ source, sourceRegex }] } },
    manifest: { routes: {}, staticFiles: {} },
  } as unknown as CheckedStack;
}

/** The listening backstage URL, or the same setup failure before a probe can dispatch. */
function backstageOf(state: { readonly url?: URL }): URL {
  if (state.url === undefined) {
    throw new TypeError('the backstage did not start');
  }
  return state.url;
}

describe('finite parameter witnesses for middleware probes', () => {
  const state: { url?: URL } = {};

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    state.url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it.each([
    { source: String.raw`/api/:id(\d{2})`, regex: String.raw`^/api/\d{2}$`, path: '/api/11' },
    { source: '/api/:id([0-9]{2,4})', regex: '^/api/[0-9]{2,4}$', path: '/api/11' },
    {
      source: String.raw`/api/:id(\d{2})/:slug([a-z]{3}).json`,
      regex: String.raw`^/api/\d{2}/[a-z]{3}\.json$`,
      path: '/api/11/aaa.json',
    },
    {
      source: String.raw`/api/:slug([A-Z]{2,3})/:id(\d{2}).json`,
      regex: String.raw`^/api/[A-Z]{2,3}/\d{2}\.json$`,
      path: '/api/AA/11.json',
    },
    { source: '/api/:id(a{2})', regex: '^/api/a{2}$', path: '/api/aa' },
  ])('probes a broken middleware covered by $source', async ({ source, regex, path }) => {
    const backstage = backstageOf(state);
    const before = observed.length;
    const verdict = await middlewareProbeVerdict(stackFor(backstage, source, regex), 'checker');
    const asked = observed.slice(before);

    expect(asked).toStrictEqual([path]);
    expect(verdict).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('500') as unknown,
    });
  });

  it('fails, rather than stopping the check, where the account cannot be read whole', async () => {
    const backstage = backstageOf(state);
    // An error's message the backstage put whole in its account, past what the check reads of it
    // (Sentry): the account is cut short, and no JSON.
    replies.next = JSON.stringify({ kind: 'failed', reason: 'x'.repeat(MIDDLEWARE_ACCOUNT_BYTES) });
    const verdict = await middlewareProbeVerdict(
      stackFor(backstage, '/api/:id(a{2})', '^/api/a{2}$'),
      'checker',
    );

    expect(verdict).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('gave no account of it that could be read') as unknown,
    });
  });

  it('reads a failure whose reason the backstage cut to what the account carries', async () => {
    const backstage = backstageOf(state);
    // A control character takes the most JSON of any, six bytes: the longest reason the backstage
    // sends still fits what the check reads of its account (Sentry).
    const reason = probeReason('\u{1}'.repeat(MIDDLEWARE_ACCOUNT_BYTES));
    const account = JSON.stringify({ kind: 'failed', reason });
    replies.next = account;
    const verdict = await middlewareProbeVerdict(
      stackFor(backstage, '/api/:id(a{2})', '^/api/a{2}$'),
      'checker',
    );

    expect(Buffer.byteLength(account)).toBeLessThan(MIDDLEWARE_ACCOUNT_BYTES);
    expect(verdict).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining(`failed: ${reason}`) as unknown,
    });
  });

  it('cuts a reason between characters, and says it was cut', () => {
    const short = 'the Function threw';

    expect(probeReason(short)).toBe(short);
    // An astral character at the cut is kept whole, not left half a surrogate pair.
    expect(probeReason(`${'a'.repeat(511)}🙂🙂`)).toBe(`${'a'.repeat(511)}🙂…`);
  });

  it.each([
    { source: String.raw`/api/:id(\d{999})`, regex: String.raw`^/api/\d{999}$` },
    { source: '/api/:id([a-z]{2,})', regex: '^/api/[a-z]{2,}$' },
  ])('keeps unsupported $source as unproved without dispatch', async ({ source, regex }) => {
    const backstage = backstageOf(state);
    const before = observed.length;
    const verdict = await middlewareProbeVerdict(stackFor(backstage, source, regex), 'checker');

    expect(verdict.kind).toBe('skipped');
    expect(observed).toHaveLength(before);
  });
});
