import { type ForwardingContext, HOP_BY_HOP_HEADERS } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

import { mergeScopedMiddlewareHeaders } from '../src/handlers/responses.ts';

const SCOPE: ForwardingContext = {
  previewDomain: 'example.test',
  previewHost: 'customer.example.test',
  clientIp: undefined,
};
const BASE_COOKIE = 'base=1; Path=/';

describe('middleware Connection options', () => {
  it.each(HOP_BY_HOP_HEADERS)(
    'drops fixed middleware transport field %s without Connection',
    (name) => {
      const target = new Headers({ 'x-visible': 'base', 'set-cookie': BASE_COOKIE });
      const added = new Headers({ [name]: 'middleware hop', 'x-visible': 'middleware' });
      added.append('set-cookie', 'one=1; Domain=.example.test; Path=/');
      const original = [...added];

      mergeScopedMiddlewareHeaders(target, added, SCOPE);

      expect(target.get(name)).toBeNull();
      expect(target.get('x-visible')).toBe('middleware');
      expect(target.getSetCookie()).toStrictEqual([BASE_COOKIE, 'one=1; Path=/']);
      expect([...added]).toStrictEqual(original);
    },
  );

  it('drop only nominated additions, preserving the base response and original headers', () => {
    const target = new Headers({ 'x-internal': 'base', 'set-cookie': BASE_COOKIE });
    const added = new Headers({
      connection: 'X-Internal, , not a name, close',
      'x-internal': 'middleware hop',
      'x-also': 'another hop',
      'x-visible': 'middleware',
    });
    added.append('connection', 'X-Also');
    added.append('set-cookie', 'one=1; Domain=.example.test; Path=/');
    added.append('set-cookie', 'two=2; Path=/other');
    const original = [...added];

    mergeScopedMiddlewareHeaders(target, added, SCOPE);

    expect({
      internal: target.get('x-internal'),
      also: target.get('x-also'),
      connection: target.get('connection'),
      visible: target.get('x-visible'),
      cookies: target.getSetCookie(),
    }).toStrictEqual({
      internal: 'base',
      also: null,
      connection: null,
      visible: 'middleware',
      cookies: [BASE_COOKIE, 'one=1; Path=/', 'two=2; Path=/other'],
    });
    expect([...added]).toStrictEqual(original);
  });

  it('drop nominated middleware cookies without deleting the base cookie', () => {
    const target = new Headers({ 'set-cookie': BASE_COOKIE });
    const added = new Headers({ connection: 'Set-Cookie', 'x-visible': 'allowed' });
    added.append('set-cookie', 'hop=1; Path=/');

    mergeScopedMiddlewareHeaders(target, added, SCOPE);

    expect(target.getSetCookie()).toStrictEqual([BASE_COOKIE]);
    expect(target.get('x-visible')).toBe('allowed');
    expect(target.has('connection')).toBe(false);
  });

  it('leave ordinary additions and cookie appends intact without Connection', () => {
    const target = new Headers({ 'x-internal': 'base', 'set-cookie': BASE_COOKIE });
    const added = new Headers({ 'x-internal': 'ordinary' });
    added.append('set-cookie', 'one=1; Domain=.example.test; Path=/');
    added.append('set-cookie', 'two=2; Path=/other');

    mergeScopedMiddlewareHeaders(target, added, SCOPE);

    expect(target.get('x-internal')).toBe('ordinary');
    expect(target.getSetCookie()).toStrictEqual([
      BASE_COOKIE,
      'one=1; Path=/',
      'two=2; Path=/other',
    ]);
  });
});
