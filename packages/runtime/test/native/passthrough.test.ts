import { describe, expect, it } from 'vitest';

import * as shared from '../../src/delivery.ts';
import { keepsItsLength, keptItsLength } from '../../src/kept-length.ts';
import * as native from '../../src/native/delivery.ts';

/**
 * Everything the runtime answers that the edge does not decide by a handler of its own, on the native
 * target (`native/delivery.ts`): passed on as the edge passes on a Function's answer
 * (`passthrough.ts`, `unsharedUnlessPublic`). On Workers (`delivery.ts`) the answer is the
 * Function's, which the edge then judges, and nothing changes here.
 */

const ORIGIN = 'http://127.0.0.1:3000';
const VISITOR = 'private, no-store';
const PUBLIC = 'public, max-age=60, s-maxage=600';

function asked(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers });
}

function answer(headers: Record<string, string>, status = 200): Response {
  return new Response(status === 304 ? null : 'body', { status, headers });
}

describe('an answer the edge would pass on, on the native target', () => {
  it('is kept by no one where the application said nothing of its keeping', () => {
    const request = asked('/api/data');

    const onNode = native.delivered(request, answer({ 'content-type': 'text/plain' }));
    const workers = shared.delivered(request, answer({ 'content-type': 'text/plain' }));

    expect(onNode.headers.get('cache-control')).toBe(VISITOR);
    expect(onNode.headers.get('content-type')).toBe('text/plain');
    // The edge decides there, from the Function's answer as it is.
    expect(workers.headers.has('cache-control')).toBe(false);
  });

  it('keeps what the application said public of it for an anonymous request, s-maxage and all', () => {
    const said = answer({ 'cache-control': PUBLIC, 'x-nextjs-cache': 'HIT' });

    const response = native.delivered(asked('/ssr'), said);

    expect(response).toBe(said);
    expect(response.headers.get('cache-control')).toBe(PUBLIC);
    expect(response.headers.get('x-nextjs-cache')).toBe('HIT');
  });

  it.each([
    ['a cookie', { cookie: 'session=1' }],
    ['an authorization', { authorization: 'Bearer token' }],
    ['a router header', { rsc: '1' }],
  ])('makes it the visitor’s for a request with %s, without s-maxage', (_name, headers) => {
    const response = native.delivered(asked('/ssr', headers), answer({ 'cache-control': PUBLIC }));

    expect(response.headers.get('cache-control')).toBe('private, max-age=60');
  });

  it('makes it the visitor’s where the answer sets a cookie', () => {
    const response = native.delivered(
      asked('/ssr'),
      answer({ 'cache-control': PUBLIC, 'set-cookie': 'a=1' }),
    );

    expect(response.headers.get('cache-control')).toBe('private, max-age=60');
    expect(response.headers.get('set-cookie')).toBe('a=1');
  });

  it('makes a lifetime said for shared caches without `public` the visitor’s', () => {
    const response = native.delivered(
      asked('/ssr'),
      answer({ 'cache-control': 's-maxage=1, stale-while-revalidate' }),
    );

    expect(response.headers.get('cache-control')).toBe('private, stale-while-revalidate');
  });

  it('drops what a CDN would read in place of the application’s word', () => {
    const response = native.delivered(
      asked('/ssr'),
      answer({ 'cache-control': PUBLIC, 'cdn-cache-control': 'max-age=3600' }),
    );

    expect(response.headers.has('cdn-cache-control')).toBe(false);
    expect(response.headers.get('cache-control')).toBe(PUBLIC);
  });

  it('judges the request as a middleware handed it on, as well as the client sent it', () => {
    const request = asked('/ssr');
    native.handedOn(request, new Headers({ authorization: 'Bearer from-the-middleware' }));

    const response = native.delivered(request, answer({ 'cache-control': PUBLIC }));

    expect(response.headers.get('cache-control')).toBe('private, max-age=60');
  });

  it('passes on an answer with no body under a status that has none', async () => {
    const response = native.delivered(asked('/ssr'), answer({}, 304));

    expect(response.status).toBe(304);
    expect(response.headers.get('cache-control')).toBe(VISITOR);
    await expect(response.text()).resolves.toBe('');
  });

  it('leaves a shipped file or an image as its own rules left it, and says nothing of its own', async () => {
    const file = native.decidedApart(
      answer({ 'cache-control': 'public, max-age=31536000, immutable', etag: '"a"' }),
    );

    const response = native.delivered(asked('/logo.png', { cookie: 'session=1' }), file);

    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('etag')).toBe('"a"');
    expect(
      [...response.headers.keys()].filter((name) => name.startsWith('x-arkor-')),
    ).toStrictEqual([]);
    await expect(response.text()).resolves.toBe('body');
  });

  it('hands on the very answer it left apart, for what its own module said of it by the object', () => {
    // A file answer goes out with its length (`keepsItsLength`), said by the answer itself.
    const file = keepsItsLength(
      native.decidedApart(answer({ 'cache-control': 'public, max-age=0, must-revalidate' })),
    );

    const response = native.delivered(asked('/hello.txt', { cookie: 'session=1' }), file);

    expect(response).toBe(file);
    expect(keptItsLength(response)).toBe(true);
    expect(response.headers.has('x-arkor-apart')).toBe(false);
  });

  it('keeps the length of a shipped document it passes on under other headers (Codex)', () => {
    // A not-found document the Function answered an unmatched URL with: passed on by this rule, as
    // the edge passes it on, and still the same bytes.
    const notFound = keepsItsLength(
      answer({ 'cache-control': 'public, max-age=0, must-revalidate', 'content-length': '4' }, 404),
    );

    const response = native.delivered(asked('/nope', { cookie: 'session=1' }), notFound);

    expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(keptItsLength(response)).toBe(true);
  });

  it('takes no header of the mark’s name the application set for the mark (coderabbit)', () => {
    // An application's answer, or one it passes on from elsewhere, naming the mark itself.
    const forged = answer({ 'cache-control': PUBLIC, 'x-arkor-apart': '1' });

    const response = native.delivered(asked('/feed', { cookie: 'session=1' }), forged);

    expect(response.headers.get('cache-control')).toBe('private, max-age=60');
  });

  it('marks nothing and keeps nothing on Workers', () => {
    const file = answer({ 'cache-control': 'public, max-age=31536000, immutable' });
    const request = asked('/logo.png');

    shared.handedOn(request, new Headers({ authorization: 'Bearer x' }));

    expect(shared.decidedApart(file)).toBe(file);
    expect(shared.delivered(request, file)).toBe(file);
  });
});
