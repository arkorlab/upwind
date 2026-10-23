/**
 * The browsers a check asks a page, a file and a page's parts as (`browsers.ts`, `parts.ts`), each
 * as it sends a navigation and asks for an image: Chrome on Windows and on Android, Safari on an
 * iPhone and on a Mac, and Firefox — each with what it sends beside its agent, Chrome's Client Hints
 * among them, and in a language of its own.
 */

/** The header a browser names itself by. */
export const USER_AGENT = 'user-agent';
/**
 * What every browser says with each navigation, and with no fetch: that it would rather a page over
 * HTTPS (`Upgrade-Insecure-Requests`, the W3C specification of it).
 */
export const UPGRADE_INSECURE_REQUESTS = 'upgrade-insecure-requests';

/** The `Accept` Safari and Firefox send with a navigation. */
const NAVIGATION_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
/** The `Accept` a Chromium browser sends with a navigation. */
const CHROMIUM_NAVIGATION_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
/**
 * A browser, as the check asks as one: what it sends with a navigation — its agent, its `Accept`,
 * a language, its hints — and what it accepts for an image a page loads, which each browser names
 * its own way.
 */
export interface Browser {
  /** The browser, in a verdict's words. */
  readonly name: string;
  readonly navigation: Readonly<Record<string, string>>;
  readonly imageAccept: string;
}

/** Chrome, as it sends a navigation and asks for an image. */
function chrome(
  userAgent: string,
  hints: {
    readonly name: string;
    readonly platform: string;
    readonly mobile: boolean;
    readonly language: string;
  },
): Browser {
  return {
    name: hints.name,
    navigation: {
      [USER_AGENT]: userAgent,
      accept: CHROMIUM_NAVIGATION_ACCEPT,
      'accept-language': hints.language,
      'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      'sec-ch-ua-mobile': hints.mobile ? '?1' : '?0',
      'sec-ch-ua-platform': `"${hints.platform}"`,
      [UPGRADE_INSECURE_REQUESTS]: '1',
    },
    imageAccept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  };
}

/** What Safari accepts for an image, on iOS and macOS alike. */
const SAFARI_IMAGE_ACCEPT =
  'image/webp,image/avif,image/jxl,image/heic,image/heic-sequence,video/*;q=0.8,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5';

/**
 * The check's own agent, asked as before any browser, as a deployment's validation asks as its
 * prover first: a name no list of crawlers names, and sending nothing a browser sends of itself
 * beside it — so that a list that names every browser (`htmlLimitedBots: Mozilla`) still leaves an
 * agent to be served the shell, as it leaves the prover. A host whose validation proves a build as
 * an agent of its own has the check ask as that one (`CheckOptions.proverAgent`).
 */
export const DEFAULT_PROVER_AGENT = 'upwind-local-check/1.0';

/** Chrome on Windows, as it names itself. */
const CHROME_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
/** Chrome on Windows, as it names itself and what it accepts on a navigation. */
const CHROME_DESKTOP_BROWSER = chrome(CHROME_DESKTOP, {
  name: 'Chrome',
  platform: 'Windows',
  mobile: false,
  language: 'en-US,en;q=0.9',
});

/**
 * What a visitor's browser says of itself on every request its page's script makes — the client
 * router's among them — whatever the navigation asked for: Chrome's, its agent, its client hints
 * and its language, without what it accepts on a navigation, or the upgrade it asks for with one.
 */
export const ROUTER_BROWSER: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CHROME_DESKTOP_BROWSER.navigation).filter(
    ([name]) => name !== 'accept' && name !== UPGRADE_INSECURE_REQUESTS,
  ),
);

/** How the browser a router runs in navigates to a page, where the page was asked as no browser. */
export const ROUTER_NAVIGATION: Readonly<Record<string, string>> =
  CHROME_DESKTOP_BROWSER.navigation;

/** Safari on an iPhone, as it sends a navigation and asks for an image. */
const SAFARI_MOBILE_BROWSER: Browser = {
  name: 'Safari',
  navigation: {
    [USER_AGENT]:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    accept: NAVIGATION_ACCEPT,
    'accept-language': 'ja-JP',
    [UPGRADE_INSECURE_REQUESTS]: '1',
  },
  imageAccept: SAFARI_IMAGE_ACCEPT,
};

export const BROWSERS: readonly Browser[] = [
  CHROME_DESKTOP_BROWSER,
  SAFARI_MOBILE_BROWSER,
  {
    name: 'Firefox',
    navigation: {
      [USER_AGENT]: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
      accept: NAVIGATION_ACCEPT,
      'accept-language': 'de-DE,de;q=0.5',
      [UPGRADE_INSECURE_REQUESTS]: '1',
    },
    imageAccept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
  },
  {
    name: 'Safari on a Mac',
    navigation: {
      [USER_AGENT]:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
      accept: NAVIGATION_ACCEPT,
      'accept-language': 'fr-FR',
      [UPGRADE_INSECURE_REQUESTS]: '1',
    },
    imageAccept: SAFARI_IMAGE_ACCEPT,
  },
  chrome(
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    { name: 'Chrome on Android', platform: 'Android', mobile: true, language: 'pt-BR,pt;q=0.9' },
  ),
];

/**
 * The browsers a page's router is asked as for its parts (`partsFailure`): each a page is asked as
 * (`BROWSERS`), as its navigation names it, in a verdict's words.
 */
export const ROUTER_BROWSERS: readonly {
  readonly navigation: Readonly<Record<string, string>>;
  readonly as: string;
}[] = BROWSERS.map((browser) => ({ navigation: browser.navigation, as: ` by ${browser.name}` }));
