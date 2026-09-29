import type { ProjectManifest } from '../manifest/index.ts';
import { isHtmlLimitedBotUserAgent } from './constants.ts';
import { atomAt, quantifierAt } from './pattern-syntax.ts';

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
 * on the application's own time, and answers the page either way. A browser's user agent, or a
 * crawler's, runs to a couple of hundred characters.
 */
const MAX_TESTED_USER_AGENT_LENGTH = 512;

/**
 * The longest pattern run here. Its alternatives without a repetition cost at most their own
 * length at each position of the user agent, so this bounds them all together: well past Next.js's
 * list (about 300 characters) with an application's own names added to it.
 */
const MAX_RUN_PATTERN_LENGTH = 4096;

/**
 * How many repetitions a pattern run here may hold that the engine backtracks over: one with more
 * of its alternative after it, as the `+` of `[\w-]+-Google` has, or one with a counted bound. Tried
 * from every position of the user agent, each costs the square of its length — 0.7 ms at 512
 * characters of word characters, measured — whatever the rest of the pattern is. Next.js's list
 * holds one; an application that extends it may add another.
 */
const MAX_BACKTRACKING_REPETITIONS = 2;

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

/** Whether the alternative a quantifier ends at `index` goes on past it. */
function continuesAfter(pattern: string, index: number): boolean {
  return index < pattern.length && pattern[index] !== '|';
}

/**
 * Whether the edge may run the pattern: alternatives of single atoms — characters, escapes, sets,
 * anchors — each with one quantifier at most, no more than `MAX_BACKTRACKING_REPETITIONS` of those
 * repetitions the engine backtracks over, and nothing else. No group, so no lookaround and no
 * backreference.
 *
 * Tried from every position of the user agent, as Next.js tries it, such a pattern costs the square
 * of the agent's length for each repetition it backtracks over, and the length of the rest of the
 * pattern for each position. Any richer shape is not bounded by the agent's length alone: two
 * repetitions side by side — `\w+\w+!`, `.*.*` — are cubic, three quartic, and the degree is the
 * application's to choose. Refusing only what backtracks exponentially, as the check a route's
 * pattern is held to does, admits those. Next.js's list, `MyBot|OtherBot` and `.*` are all of this
 * shape.
 */
function runsBounded(pattern: string): boolean {
  if (pattern.length > MAX_RUN_PATTERN_LENGTH) {
    return false;
  }
  let backtracking = 0;
  let quantified = false;
  let index = 0;
  while (index < pattern.length) {
    if (pattern[index] === '|') {
      quantified = false;
      index += 1;
      continue;
    }
    // A group, a stray quantifier or a backreference is no atom: the pattern is not of the shape.
    const atom = atomAt(pattern, index);
    if (atom === undefined) {
      return false;
    }
    const quantifier = quantifierAt(pattern, atom.end);
    if (quantifier === undefined) {
      index = atom.end;
      continue;
    }
    if (quantified) {
      return false;
    }
    quantified = true;
    const counted = pattern[atom.end] === '{';
    if (quantifier.repeats && (counted || continuesAfter(pattern, quantifier.end))) {
      backtracking += 1;
    }
    index = quantifier.end;
  }
  return backtracking <= MAX_BACKTRACKING_REPETITIONS;
}

/**
 * The application's pattern as a judge. Next.js's own list is read as `isHtmlLimitedBotUserAgent`
 * reads it, and stands in for a pattern not of the shape the edge runs (`runsBounded`) or that
 * does not compile: it is the one list the edge can run safely for any application.
 *
 * The two it stands in for cost different things. A pattern that does not compile, the Function
 * does not run either, so a crawler passed on for it is only answered later. A pattern of another
 * shape the Function does run. A partially prerendered route carries it all the same, in the
 * user-agent condition of its `bypassFor`, which is judged on the route the request lands on, as
 * Next.js's router judges it: a visitor it names is passed on there. What is lost is a visitor it
 * names only in another case, since that condition, unlike this judge, is case-sensitive — the
 * price of never running such a pattern here, paid by the application that wrote it rather than
 * by every application the edge serves.
 */
function judgeOf(pattern: string): BlockingJudge {
  if (pattern === NEXT_HTML_LIMITED_BOTS || !runsBounded(pattern)) {
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
