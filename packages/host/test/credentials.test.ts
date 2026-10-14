import { describe, expect, it } from 'vitest';

import { functionBinding } from '../src/bindings/index.ts';
import { withoutHostCredentials } from '../src/credentials/index.ts';

/** What a host keeps for itself: a session cookie and a header of its own. */
const HOST = { cookies: ['host_session'], headers: ['x-host-token'] } as const;

describe('a request on its way to an application', () => {
  it('loses the cookies the host names, and keeps every other', () => {
    const headers = withoutHostCredentials(
      new Headers({ cookie: 'theme=dark; host_session=secret; cart=3' }),
      HOST,
    );

    expect(headers.get('cookie')).toBe('theme=dark; cart=3');
  });

  /** An empty `Cookie` header is not one the client sent. */
  it('loses its cookie header where every cookie in it is the host’s', () => {
    const headers = withoutHostCredentials(new Headers({ cookie: 'host_session=secret' }), HOST);

    expect(headers.has('cookie')).toBe(false);
  });

  it('is sent no cookie header where it had none', () => {
    const headers = withoutHostCredentials(new Headers({ accept: 'text/html' }), HOST);

    expect(headers.has('cookie')).toBe(false);
    expect(headers.get('accept')).toBe('text/html');
  });

  it('loses the headers the host names, whatever their case', () => {
    const headers = withoutHostCredentials(
      new Headers({ 'X-Host-Token': 'secret', 'x-app': 'kept' }),
      HOST,
    );

    expect(headers.has('x-host-token')).toBe(false);
    expect(headers.get('x-app')).toBe('kept');
  });

  /** A host that names no cookie leaves the header as the client wrote it, not written again. */
  it('keeps its cookie header as the client wrote it where the host names no cookie', () => {
    const written = 'theme=dark;cart=3; ;';
    const headers = withoutHostCredentials(new Headers({ cookie: written }), {
      cookies: [],
      headers: [],
    });

    expect(headers.get('cookie')).toBe(written);
  });

  it('is changed in place, and handed back', () => {
    const headers = new Headers({ cookie: 'host_session=secret' });

    expect(withoutHostCredentials(headers, HOST)).toBe(headers);
    expect(headers.has('cookie')).toBe(false);
  });
});

describe('the binding a Function is reached by', () => {
  it('is its script name after APP__', () => {
    expect(functionBinding('site')).toBe('APP__site');
  });

  /** A binding's name holds letters, digits and `_` alone. */
  it('has every other character of the name made _', () => {
    expect(functionBinding('my-worker.v2')).toBe('APP__my_worker_v2');
    expect(functionBinding('café')).toBe('APP__caf_');
  });

  /** Which is why whatever deploys names its Functions apart in what a binding can hold. */
  it('is one binding for two names that differ only in such characters', () => {
    expect(functionBinding('my-worker')).toBe(functionBinding('my_worker'));
  });
});
