import { afterAll, describe, expect, it } from 'vitest';

import { asMiddleware } from '../src/middleware-scope.ts';

/**
 * The build manifest a page of the edge runtime sets on the global object, as the middleware sees
 * it. Next.js's adapter takes a middleware that sees one for such a page, and in this Worker every
 * page on the edge runtime shares the middleware's global object.
 */

const BUILD_MANIFEST = '__BUILD_MANIFEST';

function manifestType(): string {
  return typeof Reflect.get(globalThis, BUILD_MANIFEST);
}

describe("an edge page's build manifest", () => {
  afterAll(() => {
    Reflect.deleteProperty(globalThis, BUILD_MANIFEST);
  });

  it('reads as unset inside a middleware alone, whenever the page set it', async () => {
    // A page loaded before the middleware ever ran.
    Reflect.set(globalThis, BUILD_MANIFEST, { pages: {} });
    const seen: string[] = [];
    const gate = Promise.withResolvers<undefined>();
    const middleware = asMiddleware(async () => {
      seen.push(manifestType());
      await gate.promise;
      seen.push(manifestType());
      return new Response(null);
    });

    const running = middleware(new Request('https://app.test/'), {});
    // A page renders while the middleware is still running, and another is loaded meanwhile.
    const during = manifestType();
    Reflect.set(globalThis, BUILD_MANIFEST, { pages: { '/': [] } });
    gate.resolve(undefined);
    await running;

    expect(during).toBe('object');
    expect(seen).toStrictEqual(['undefined', 'undefined']);
    expect(Reflect.get(globalThis, BUILD_MANIFEST)).toStrictEqual({ pages: { '/': [] } });
  });
});
