import { NEXT_ACTION_HEADER } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

import { methodNotAllowed, readsOnly } from '../src/methods.ts';
import type { Store } from '../src/store.ts';

/**
 * The methods a page the build rendered is answered for. `next start` refuses every
 * method but a read on a Pages Router page with `getStaticProps`, with `405` and
 * `Allow: GET, HEAD` (`base-server.js`), before it renders; the page handler an adapter calls has no
 * such check, and answered a `POST` with the page.
 */

const ABOUT = '/about';

function store(rendered: readonly string[], config: Partial<Store['manifest']['config']> = {}) {
  return {
    manifest: { config: { basePath: '', i18n: null, ...config } },
    renderedPages: new Set(rendered),
  } as unknown as Store;
}

function post(headers: Record<string, string> = {}): Request {
  return new Request(`https://app.test${ABOUT}`, { method: 'POST', headers });
}

describe('a page the build rendered', () => {
  it('answers reads only, and refuses the rest as Next.js does', async () => {
    const asked = { route: ABOUT, pathname: ABOUT };

    expect(readsOnly(store([ABOUT]), asked, post())).toBe(true);
    expect(readsOnly(store([ABOUT]), asked, new Request(`https://app.test${ABOUT}`))).toBe(true);

    const refusal = methodNotAllowed();

    expect(refusal.status).toBe(405);
    expect(refusal.headers.get('allow')).toBe('GET, HEAD');
    await expect(refusal.text()).resolves.toBe('Method Not Allowed');
  });

  it('is judged by the member a request resolved to, as well as by its route', () => {
    const asked = { route: '/posts/[slug]', pathname: '/posts/one' };

    expect(readsOnly(store(['/posts/one']), asked, post())).toBe(true);
  });

  /**
   * `next start` asks this before it refuses, whatever router the page is of
   * (`getIsPossibleServerAction`, in `base-server.js`): a form a Pages Router page posts to itself
   * is rendered there, not refused — on purpose, "to prevent changes in behavior when a regular
   * page component tries to handle a POST" (`server-action-request-meta.js`).
   */
  it('leaves a POST that may be a Server Action to the page', () => {
    const asked = { route: ABOUT, pathname: ABOUT };

    expect(readsOnly(store([ABOUT]), asked, post({ [NEXT_ACTION_HEADER]: 'abc' }))).toBe(false);
    expect(
      readsOnly(
        store([ABOUT]),
        asked,
        post({ 'content-type': 'application/x-www-form-urlencoded' }),
      ),
    ).toBe(false);
    expect(
      readsOnly(store([ABOUT]), asked, post({ 'content-type': 'multipart/form-data; boundary=x' })),
    ).toBe(false);
  });

  it('leaves the status pages to answer every method, behind a base path and a locale', () => {
    const config = { basePath: '/docs', i18n: { defaultLocale: 'en', locales: ['en', 'fr'] } };
    const rendered = store(['/docs/404'], config);

    expect(readsOnly(rendered, { route: '/docs/fr/404', pathname: '/docs/fr/404' }, post())).toBe(
      false,
    );
    expect(readsOnly(rendered, { route: '/docs/404', pathname: '/docs/404' }, post())).toBe(false);
  });

  it('is not every page: one the build did not render answers whatever it answers', () => {
    expect(readsOnly(store([]), { route: ABOUT, pathname: ABOUT }, post())).toBe(false);
  });
});
