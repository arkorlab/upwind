import { buildProjectManifest, type ProjectManifest } from '@stayingupwind/core/manifest';
import { wantsBlockingMetadata } from '@stayingupwind/core/request';
import { shouldServeStreamingMetadata } from 'next/dist/server/lib/streaming-metadata.js';
import { HTML_LIMITED_BOT_UA_RE_STRING } from 'next/dist/shared/lib/router/utils/is-bot.js';
import { describe, expect, it } from 'vitest';

/**
 * The edge serves no shell to exactly the visitors Next.js sends blocking metadata to, and so
 * renders the page whole for: asked of the installed Next.js as the page's handler asks it
 * (`shouldServeStreamingMetadata`, and a request that names no agent streamed to), not of a copy of
 * its list. Under the pattern a build records for an application that names none — Next.js's own,
 * which loading the config fills in — and under lists of an application's own.
 */

const OBSERVED_AT = '2026-09-15T00:00:00.000Z';

/** A manifest whose application's `htmlLimitedBots` is `pattern`; `undefined` records none. */
function manifestUnder(pattern: string | undefined): ProjectManifest {
  return buildProjectManifest({
    projectId: 'p',
    runId: 'r',
    generatedAt: OBSERVED_AT,
    originHost: 'app.example.test',
    deployment: { assetSetHash: 'h', observedAt: OBSERVED_AT },
    routes: [],
    app: { deploymentId: 'dpl_1', scriptName: 'app' },
    ...(pattern !== undefined && { htmlLimitedBots: pattern }),
  });
}

function nextSendsBlockingMetadata(userAgent: string, pattern: string | undefined): boolean {
  return userAgent !== '' && !shouldServeStreamingMetadata(userAgent, pattern);
}

const USER_AGENTS = [
  '',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'AdsBot-Google (+http://www.google.com/adsbot.html)',
  'Mediapartners-Google',
  'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Twitterbot/1.0',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (compatible; mybot/1.0)',
  // Next.js compiles its list with `i` and not `u`, which folds no character outside ASCII onto a
  // letter of it: not the Kelvin sign onto `k`, `İ` onto `i`, nor `ſ` onto `s` or into `\w`.
  'Slac\u{212A}bot-LinkExpanding 1.0',
  'YET\u{130}/1.0',
  '\u{17F}-Google',
];

describe('who the edge serves no shell to', () => {
  /** Read as the edge reads Next.js's own list, at any length: a long agent is judged, not passed. */
  it.each([undefined, HTML_LIMITED_BOT_UA_RE_STRING])(
    'is who Next.js sends blocking metadata to under its own list (%s)',
    (pattern) => {
      const manifest = manifestUnder(pattern);
      const agents = [...USER_AGENTS, `Mozilla/5.0 ${'x'.repeat(600)}`];

      for (const userAgent of agents) {
        expect([userAgent, wantsBlockingMetadata(userAgent, manifest)]).toStrictEqual([
          userAgent,
          nextSendsBlockingMetadata(userAgent, pattern),
        ]);
      }
    },
  );

  it.each(['MyBot|OtherBot', 'Twitterbot', '.*', String.raw`[\w-]+-Google|Mozilla.*|MyBot`])(
    'is who Next.js sends blocking metadata to under the application’s list %s',
    (pattern) => {
      const manifest = manifestUnder(pattern);

      for (const userAgent of USER_AGENTS) {
        expect([userAgent, wantsBlockingMetadata(userAgent, manifest)]).toStrictEqual([
          userAgent,
          nextSendsBlockingMetadata(userAgent, pattern),
        ]);
      }
    },
  );
});
