import { describe, expect, it } from 'vitest';

import {
  decodeLocaleRequest,
  encodeLocaleRequest,
  LOCALE_REQUEST_HEADER,
  localeRequestOf,
  PLATFORM_REQUEST_HEADERS,
} from '../src/paas/index.ts';
import { encodeUtf8, toBase64Url } from '../src/util/bytes.ts';

describe('original locale request metadata', () => {
  it('captures explicit absence without carrying any unrelated cookie', () => {
    expect(
      localeRequestOf(new Headers({ cookie: 'session=secret; unrelated=value' })),
    ).toStrictEqual({
      language: null,
      cookie: null,
    });
    expect(PLATFORM_REQUEST_HEADERS).toContain(LOCALE_REQUEST_HEADER);
  });

  it.each([
    ['session=secret; NEXT_LOCALE=%66%72; NEXT_LOCALE=en', 'NEXT_LOCALE=%66%72'],
    ['NEXT_LOCALE; NEXT_LOCALE="fr"; session=secret', 'NEXT_LOCALE="fr"'],
    ['NEXT_LOCALE=; NEXT_LOCALE=fr', 'NEXT_LOCALE='],
    ['NEXT_LOCALE = fr ; session=secret', 'NEXT_LOCALE=fr'],
  ])('keeps only the first syntactically valid locale pair from %s', (cookie, expected) => {
    const request = localeRequestOf(new Headers({ 'accept-language': 'en,fr;q=0.8', cookie }));

    expect(decodeLocaleRequest(encodeLocaleRequest(request))).toStrictEqual({
      language: 'en,fr;q=0.8',
      cookie: expected,
    });
  });

  it('roundtrips UTF-8 through an ASCII-only transport without dropping nulls', () => {
    const request = { language: 'fr,記事;q=0.1', cookie: null };
    const encoded = encodeLocaleRequest(request);

    expect(encoded).toMatch(/^[\w-]+$/u);
    expect(decodeLocaleRequest(encoded)).toStrictEqual(request);
    expect(
      decodeLocaleRequest(encodeLocaleRequest({ language: null, cookie: null })),
    ).toStrictEqual({
      language: null,
      cookie: null,
    });
  });

  it.each([
    {},
    null,
    [],
    { language: null },
    { language: [], cookie: null },
    { language: null, cookie: 'session=secret' },
    { language: null, cookie: 'NEXT_LOCALE=fr; session=secret' },
    { language: null, cookie: null, session: 'secret' },
    { language: 'fr\r\nforged: value', cookie: null },
  ])('refuses malformed or non-locale metadata %j', (value) => {
    const encoded = toBase64Url(encodeUtf8(JSON.stringify(value)));

    expect(decodeLocaleRequest(encoded)).toBeUndefined();
  });

  it('refuses invalid base64 and non-JSON content', () => {
    const nonJson = toBase64Url(encodeUtf8('not JSON'));

    expect(decodeLocaleRequest('not!base64')).toBeUndefined();
    expect(decodeLocaleRequest(nonJson)).toBeUndefined();
  });
});
