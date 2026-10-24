import { packPrerenders } from '@stayingupwind/core/bundle';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { crawlerWantsWholePage } from '../src/documents.ts';
import { findShell, getStore } from '../src/store.ts';

// The time each test had where this suite ran before.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Who is answered with a `fallback: true` document and who is answered with the page.
 *
 * Next.js renders a member of such a route blocking for a crawler rather than serve the fallback
 * (`isIsrFallback && isBot(…)`, in its pages handler), so that what a crawler indexes is the page
 * and not its loading state. The Worker answers from the build's fallback document itself, so
 * Next.js is never asked, and the rule has to be made here or not at all.
 */

const bundle = vi.hoisted(() => ({ files: new Map<string, Uint8Array>() }));

/**
 * Nothing here renders. The bridge is on the import path all the same (`documents.ts` reaches it
 * through `serve.ts`), and `cloudflare:node` is not a module Node has.
 */
function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

vi.mock(import('node:fs'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    readFileSync: ((path: string) => {
      const bytes = bundle.files.get(path);
      if (bytes === undefined) {
        throw new Error(`no such file ${path}`);
      }
      return Buffer.from(bytes);
    }) as typeof original.readFileSync,
  };
});

const PAGES_ROUTE = '/blog/[slug]';
const APP_ROUTE = '/items/[id]';
const BODY = { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/html' };
/** The eight agents `prerender-crawler` asks with, as it writes them. */
const CRAWLERS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)',
  'DuckDuckBot/1.0; (+http://duckduckgo.com/duckduckbot.html)',
  'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
  'facebookexternalhit/1.0 (+http://www.facebook.com/externalhit_uatext.php)',
  'ia_archiver (+http://www.alexa.com/site/help/webmasters; crawler@alexa.com)',
];
const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.82 Safari/537.36';

/**
 * A page, or — the route's own template — what stands for its class, as Next.js 16.3 says of it: the
 * Pages Router's `fallback: true` document, and the App Router's shell.
 */
function prerender(route: string, pathname: string) {
  const template = route.startsWith('/items') ? 'shell' : 'fallback';
  const routeType = pathname === route ? template : 'page';
  return { id: pathname, pathname, route, routeType, body: BODY };
}

function asks(pathname: string, userAgent: string): boolean {
  const store = getStore();
  const route = pathname.startsWith('/items') ? APP_ROUTE : PAGES_ROUTE;
  const shell = findShell(store, route, pathname);
  if (shell === undefined) {
    throw new Error(`no shell stands for ${pathname}`);
  }
  const request = new Request(`https://app.test${pathname}`, {
    headers: { 'user-agent': userAgent },
  });
  return crawlerWantsWholePage(store, shell, { route, pathname, url: pathname }, request);
}

describe('a fallback document and who it is for', () => {
  beforeEach(() => {
    const manifest = {
      buildId: 'build',
      config: { basePath: '', i18n: null },
      routing: { dynamicRoutes: [] },
      entrypoints: [
        { id: 'pages/blog/[slug]', kind: 'pages', pathname: PAGES_ROUTE },
        { id: 'app/items/[id]/page', kind: 'app-page', pathname: APP_ROUTE },
      ],
      prerenders: packPrerenders([
        prerender(PAGES_ROUTE, '/blog/[slug]'),
        prerender(PAGES_ROUTE, '/blog/first'),
        prerender(APP_ROUTE, '/items/[id]'),
      ]),
      staticFiles: [],
    };
    bundle.files.set('/bundle/runtime.json', new TextEncoder().encode(JSON.stringify(manifest)));
  });

  it('is not what a crawler is answered with, for a member the build left out', () => {
    expect(CRAWLERS.map((agent) => asks('/blog/test-1', agent))).toStrictEqual(
      CRAWLERS.map(() => true),
    );
  });

  it('is what a browser is answered with, for the same member', () => {
    expect(asks('/blog/test-1', BROWSER)).toBe(false);
  });

  it('is not in question for a member the build prerendered', () => {
    expect(asks('/blog/first', CRAWLERS[0] ?? '')).toBe(false);
  });

  /**
   * An App Router shell is resumed for every visitor; the crawler it treats differently it sends
   * blocking metadata to, which is a rule of its own.
   */
  it('is not in question for an App Router shell', () => {
    expect(asks('/items/anything', CRAWLERS[0] ?? '')).toBe(false);
  });

  it('is what a visitor with no user agent is answered with', () => {
    expect(asks('/blog/test-1', '')).toBe(false);
  });
});
