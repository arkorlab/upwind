import { afterEach, describe, expect, it, vi } from 'vitest';

import { installHeadersIterator } from '../src/headers-iterator.ts';

const NativeHeaders = Headers;
// eslint-disable-next-line @typescript-eslint/unbound-method, vitest/unbound-method -- Keep the actual native function for identity and receiver-brand checks.
const nativeEntries = NativeHeaders.prototype.entries;
const originalIterator = Object.getOwnPropertyDescriptor(NativeHeaders.prototype, Symbol.iterator);
if (originalIterator === undefined) {
  throw new Error('The native Headers iterator must have its own descriptor.');
}

/** A separate native-backed iterator, as workerd registers beside its entries method. */
function separateIterator(this: Headers): ReturnType<Headers['entries']> {
  return nativeEntries.call(this);
}

/** Only the prototype is inspected: the installer must never construct this fixture. */
function fixtureHeaders(): never {
  throw new Error('The Headers fixture must not be constructed.');
}

type HeaderPrototype = Headers | Record<PropertyKey, unknown>;

function usePrototype(prototype: HeaderPrototype): void {
  Object.defineProperty(fixtureHeaders, 'prototype', { value: prototype });
  vi.stubGlobal('Headers', fixtureHeaders);
}

/** Keep a symbol-keyed descriptor map from being mistaken for an iterable by assertion helpers. */
function descriptorsOf(
  prototype: HeaderPrototype,
): (readonly [PropertyKey, PropertyDescriptor | undefined])[] {
  return Reflect.ownKeys(prototype).map(
    (key) => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const,
  );
}

describe('the native Headers iterator alias', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(NativeHeaders.prototype, Symbol.iterator, originalIterator);
  });

  it('repairs existing native header owners without changing their data, brands or guards', async () => {
    Object.defineProperty(NativeHeaders.prototype, Symbol.iterator, {
      ...originalIterator,
      value: separateIterator,
    });
    const headers = new NativeHeaders({ 'x-example': 'value' });
    headers.append('set-cookie', 'first=1');
    headers.append('set-cookie', 'second=2');
    const request = new Request('https://example.invalid/', { headers });
    const response = new Response('body', { headers });
    const entriesDescriptor = Object.getOwnPropertyDescriptor(NativeHeaders.prototype, 'entries');
    const owners = [
      headers,
      request.headers,
      request.clone().headers,
      response.headers,
      response.clone().headers,
    ];
    const pairsBefore = owners.map((owner) => [...owner]);
    const cookiesBefore = owners.map((owner) => owner.getSetCookie());
    // The data URL is handled in process; no HTTP request is made.
    const fetched = await fetch('data:text/plain,body');
    const fetchedPairsBefore = [...fetched.headers];
    const fetchedCookiesBefore = fetched.headers.getSetCookie();

    expect(headers[Symbol.iterator]).not.toBe(nativeEntries);

    installHeadersIterator();

    expect({
      aliases: owners.map((owner) => owner[Symbol.iterator]),
      entries: Object.getOwnPropertyDescriptor(NativeHeaders.prototype, 'entries'),
      iterator: Object.getOwnPropertyDescriptor(NativeHeaders.prototype, Symbol.iterator),
    }).toStrictEqual({
      aliases: owners.map(() => nativeEntries),
      entries: entriesDescriptor,
      iterator: { ...originalIterator, value: nativeEntries },
    });
    expect(headers[Symbol.iterator].name).toBe('entries');
    expect({
      pairs: owners.map((owner) => [...owner]),
      cookies: owners.map((owner) => owner.getSetCookie()),
    }).toStrictEqual({ pairs: pairsBefore, cookies: cookiesBefore });
    expect({ pairs: [...headers], cookies: headers.getSetCookie() }).toStrictEqual({
      pairs: [
        ['set-cookie', 'first=1'],
        ['set-cookie', 'second=2'],
        ['x-example', 'value'],
      ],
      cookies: ['first=1', 'second=2'],
    });
    expect({
      iterator: fetched.headers[Symbol.iterator],
      pairs: [...fetched.headers],
      cookies: fetched.headers.getSetCookie(),
      body: await fetched.text(),
    }).toStrictEqual({
      iterator: nativeEntries,
      pairs: fetchedPairsBefore,
      cookies: fetchedCookiesBefore,
      body: 'body',
    });
    expect(() => {
      fetched.headers.set('x-example', 'changed');
    }).toThrow(TypeError);
    expect(() => Reflect.apply(headers[Symbol.iterator], {}, [])).toThrow(TypeError);
  });

  it('leaves an already conforming prototype unchanged on repeated installation', () => {
    Object.defineProperty(NativeHeaders.prototype, Symbol.iterator, {
      ...originalIterator,
      value: nativeEntries,
    });
    const before = descriptorsOf(NativeHeaders.prototype);

    installHeadersIterator();
    installHeadersIterator();

    expect(descriptorsOf(NativeHeaders.prototype)).toStrictEqual(before);
    expect(NativeHeaders.prototype[Symbol.iterator]).toBe(nativeEntries);
  });

  it('leaves readonly iterators alone regardless of configurability', () => {
    const prototypes = [false, true].map((configurable) => {
      return Object.defineProperties(
        {},
        {
          entries: { value: nativeEntries },
          [Symbol.iterator]: { value: separateIterator, configurable, writable: false },
        },
      );
    });
    const before = prototypes.map((prototype) => descriptorsOf(prototype));

    expect(() => {
      for (const prototype of prototypes) {
        usePrototype(prototype);
        installHeadersIterator();
      }
    }).not.toThrow();
    expect(prototypes.map((prototype) => descriptorsOf(prototype))).toStrictEqual(before);
  });

  it('does not evaluate accessor descriptors while checking a custom prototype', () => {
    const getter = vi.fn(() => nativeEntries);
    const prototype = Object.defineProperties(
      {},
      {
        entries: { get: getter },
        [Symbol.iterator]: { get: getter },
      },
    );
    const before = descriptorsOf(prototype);
    usePrototype(prototype);

    installHeadersIterator();

    expect(getter).not.toHaveBeenCalled();
    expect(descriptorsOf(prototype)).toStrictEqual(before);
  });
});
