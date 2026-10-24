import { describe, expect, it } from 'vitest';

import { decodesLayeredBrotli } from '../src/handlers/layered-clients.ts';
import {
  CHROME_USER_AGENT,
  CURL_USER_AGENT,
  FIREFOX_USER_AGENT,
  IPHONE_CHROME_USER_AGENT,
  IPHONE_FIREFOX_USER_AGENT,
  IPHONE_SAFARI_USER_AGENT,
  SAFARI_USER_AGENT,
} from './helpers/user-agents.ts';

describe('which clients are sent the second brotli layer', () => {
  /** Chromium under any name, Firefox, and curl: each chains a decoder per coding. */
  it.each([
    ['Chrome on the Mac', CHROME_USER_AGENT],
    [
      'Chrome on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    ],
    [
      'Chrome on Android',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    ],
    [
      "Android's WebView",
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.51 Mobile Safari/537.36',
    ],
    [
      'Edge',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
    ],
    [
      'Opera',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 OPR/123.0.0.0',
    ],
    [
      'Samsung Internet',
      'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    ],
    ['Firefox on Windows', FIREFOX_USER_AGENT],
    ['Firefox on Android', 'Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0'],
    ['curl', CURL_USER_AGENT],
  ])('sends two layers to %s', (_client, userAgent) => {
    expect(decodesLayeredBrotli(userAgent)).toBe(true);
  });

  /**
   * Safari, and so every browser on iOS, whatever it calls itself and whichever site it asked for;
   * anything else a browser's name is borrowed by; and whatever names no stack at all.
   */
  it.each([
    ['Safari, and an iPad asking for the desktop site', SAFARI_USER_AGENT],
    ['Safari on the iPhone', IPHONE_SAFARI_USER_AGENT],
    ['Chrome on the iPhone', IPHONE_CHROME_USER_AGENT],
    [
      'Chrome on the iPad, asking for the desktop site',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140 Version/18.5 Safari/605.1.15',
    ],
    ['Firefox on the iPhone', IPHONE_FIREFOX_USER_AGENT],
    [
      'Edge on the iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/140.3485.94 Mobile/15E148 Safari/605.1.15',
    ],
    [
      'an app on the iPhone that claims to be Chrome',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile/15E148 Safari/604.1',
    ],
    [
      'legacy Edge',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19582',
    ],
    [
      'a fetcher that borrows Chrome’s name',
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.207 Mobile Safari/537.36 (compatible; GoogleOther)',
    ],
    [
      'a crawler that borrows Chrome’s name',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ExampleCrawler/1.0',
    ],
    [
      'Googlebot, which is served a composed document as a browser is',
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    ],
    [
      'headless Chrome',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36',
    ],
    ['an HTTP library', 'python-requests/2.32.5'],
    ['an empty user agent', ''],
    ['a request that names none', null],
  ])('sends one layer to %s', (_client, userAgent) => {
    expect(decodesLayeredBrotli(userAgent)).toBe(false);
  });
});
