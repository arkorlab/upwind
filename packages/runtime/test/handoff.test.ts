import { describe, expect, it } from 'vitest';

import {
  applyRequestChanges,
  decodeHandOff,
  encodeHandOff,
  type HandOff,
  requestChanges,
} from '../src/handoff.ts';

/** What one app Function's routing hands the Function that holds the route, and back again. */

const HAND_OFF: HandOff = {
  route: '/[locale]/blog/[slug]',
  pathname: '/ja/blog/記事',
  url: '/ja/blog/%E8%A8%98%E4%BA%8B?ref=1',
  headers: [
    ['set-cookie', 'a=1; Path=/'],
    ['set-cookie', 'b=2; Path=/'],
    ['x-rule', 'on'],
  ],
  status: 404,
  set: [['x-from-proxy', '1']],
  removed: ['x-client'],
};

describe('a routing hand-off', () => {
  it('reads back as it was written, every cookie and every character of it', () => {
    const value = encodeHandOff(HAND_OFF);

    expect(value).toMatch(/^[\w-]+$/u);
    expect(decodeHandOff(value)).toStrictEqual(HAND_OFF);
  });

  it.each([
    ['not base64url JSON', 'not a hand-off'],
    ['the wrong shape', Buffer.from(JSON.stringify({ route: 1 })).toString('base64url')],
    [
      'headers that are not pairs',
      Buffer.from(JSON.stringify({ ...HAND_OFF, headers: [['only-a-name']] })).toString(
        'base64url',
      ),
    ],
  ])('is nothing for %s', (_case, value) => {
    expect(decodeHandOff(value)).toBeUndefined();
  });

  it.each([null, [], { phase: 1 }, { tag: ['one', 2] }, { phase: { nested: 'value' } }])(
    'refuses an invalid effective query %j',
    (query) => {
      const value = Buffer.from(JSON.stringify({ ...HAND_OFF, query })).toString('base64url');

      expect(decodeHandOff(value)).toBeUndefined();
    },
  );

  it('carries only what the middleware changed of the request headers', () => {
    const before = new Headers({ accept: 'text/html', 'x-client': 'yes', 'x-same': '1' });
    const after = new Headers({ accept: 'text/html', 'x-from-proxy': '1', 'x-same': '1' });

    expect(requestChanges(before, after)).toStrictEqual({
      set: [['x-from-proxy', '1']],
      removed: ['x-client'],
    });
    expect(requestChanges(before, undefined)).toStrictEqual({});
  });

  it('keeps every value of a name that holds several, and changes none it left alone', () => {
    const before = new Headers([
      ['set-cookie', 'a=1'],
      ['x-same', '1'],
    ]);
    const after = new Headers([
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
      ['x-same', '1'],
    ]);
    const changes = requestChanges(before, after);

    expect(changes).toStrictEqual({
      set: [
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
    });
    expect(
      applyRequestChanges(before, { ...HAND_OFF, ...changes, removed: [] }).getSetCookie(),
    ).toStrictEqual(['a=1', 'b=2']);
  });

  it('rebuilds the request headers the middleware left from the ones it was handed', () => {
    const handed = new Headers({ accept: 'text/html', 'x-client': 'yes' });
    const rebuilt = applyRequestChanges(handed, HAND_OFF);

    expect(Object.fromEntries(rebuilt)).toStrictEqual({
      accept: 'text/html',
      'x-from-proxy': '1',
    });
  });
});
