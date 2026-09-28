import type { ProjectManifest } from '../manifest/index.ts';
import { isHtmlLimitedBotUserAgent } from './constants.ts';
import { unsafeSourcePatternReason } from './pattern-safety.ts';

/**
 * Who Next.js sends blocking metadata to, asked where a shell would be served.
 *
 * A partially prerendered page streams its metadata after the shell. For a visitor Next.js sends
 * blocking metadata to, it renders the page whole instead (`shouldForceDynamicPPRRender`, in the
 * page's handler): the shell was made for streamed metadata, and a render that completed it would
 * be made for the other tree. Who that is Next.js reads off the application's `htmlLimitedBots`,
 * tested case-insensitively anywhere in the user agent (`shouldServeStreamingMetadata`), or off its
 * own list when the application names none. Not off its list of crawlers: Googlebot, which runs a
 * browser, is streamed to and served the shell as any browser is.
 */

/**
 * The longest user agent an application's pattern is run against here. A longer one is taken to
 * be named by it, which leaves the request to the Function: that runs the pattern as Next.js does,
 * on the application's own time, and answers the page either way.
 *
 * The pattern is the application's, and the edge runs it for every application it serves. The
 * shape check a route's source is held to (`unsafeSourcePatternReason`) refuses what backtracks
 * exponentially, and does not claim that what it admits is linear: run anywhere in a value, as
 * Next.js runs this one, an admitted `[\w-]+-Google` — Next.js's own list, which an application may
 * extend — is quadratic in the length of the user agent. Measured against a run of word
 * characters: 0.5 ms at this length, 30 ms at 4096, half a second at 16384. A browser's user agent,
 * or a crawler's, runs to a couple of hundred characters.
 */
const MAX_TESTED_USER_AGENT_LENGTH = 512;

/**
 * Next.js's own list, as the source it tests (`HTML_LIMITED_BOT_UA_RE_STRING`, `is-bot.js`).
 * Loading the config puts it in `htmlLimitedBots` when an application names no list, so it is the
 * pattern nearly every build records. It is the list `isHtmlLimitedBotUserAgent` reads without
 * backtracking, so it is read that way, at any length, rather than compiled.
 */
const NEXT_HTML_LIMITED_BOTS = String.raw`[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`;

type BlockingJudge = (userAgent: string) => boolean;

/**
 * The application's pattern compiled, once for each manifest that carries it: the same for every
 * request of the deployment, and gone with the manifest.
 */
const judges = new WeakMap<ProjectManifest, BlockingJudge>();

/**
 * The application's pattern as a judge. Next.js's own list is read as `isHtmlLimitedBotUserAgent`
 * reads it, and stands in for a pattern the shape check refuses or that does not compile: it is the
 * one list the edge can run safely for any application.
 *
 * The two it stands in for cost different things. A pattern that does not compile, the Function
 * does not run either, so a crawler passed on for it is only answered later. A refused pattern the
 * Function does run, so a visitor it names and Next.js's list does not is served a shell whose
 * completion is rendered for blocking metadata — the price of never running the pattern here, paid
 * by the application whose list backtracks rather than by every application the edge serves.
 */
function judgeOf(pattern: string): BlockingJudge {
  if (pattern === NEXT_HTML_LIMITED_BOTS || unsafeSourcePatternReason(pattern) !== undefined) {
    return isHtmlLimitedBotUserAgent;
  }
  let regex: RegExp;
  try {
    // Compiled as Next.js compiles it: case-insensitive, without the unicode flag.
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
    regex = new RegExp(pattern, 'i');
  } catch {
    return isHtmlLimitedBotUserAgent;
  }
  return (userAgent) => userAgent.length > MAX_TESTED_USER_AGENT_LENGTH || regex.test(userAgent);
}

/**
 * Whether Next.js sends blocking metadata to this user agent in the application a manifest
 * publishes, and so renders its page whole rather than completing a shell. A request that names no
 * agent is streamed to, as Next.js streams to one, whatever the pattern; an empty pattern is none,
 * as Next.js reads it.
 */
export function wantsBlockingMetadata(
  userAgent: string | null,
  manifest: ProjectManifest | undefined,
): boolean {
  if (userAgent === null || userAgent === '') {
    return false;
  }
  const pattern = manifest?.htmlLimitedBots;
  if (manifest === undefined || pattern === undefined || pattern === '') {
    return isHtmlLimitedBotUserAgent(userAgent);
  }
  let judge = judges.get(manifest);
  if (judge === undefined) {
    judge = judgeOf(pattern);
    judges.set(manifest, judge);
  }
  return judge(userAgent);
}
