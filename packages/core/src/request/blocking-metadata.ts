import type { ProjectManifest, RouteEntry } from '../manifest/index.ts';
import { anyConditionHolds } from './conditions.ts';
import { isHtmlLimitedBotUserAgent } from './constants.ts';
import {
  afterCharacterClass,
  afterGroup,
  atomAt,
  groupContents,
  quantifierAt,
} from './pattern-syntax.ts';

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
 *
 * What these limits bound is a test once the engine has compiled the pattern. The first tests cost
 * more: the engine compiles the pattern when it is first run and again when it tiers it up. A
 * 4096-character alternation of sets, against a 512-character agent, has measured from 2 to
 * 12.5 ms on its first test, against well under 1 ms once tiered up. That is paid once for each
 * manifest an isolate judges by (`judgements`), not once for each request. A navigation to a
 * partially prerendered route asks the judge twice, though — once in the classification and once
 * for the route's `bypassFor` (`bypassForHolds`) — so it pays a test's cost twice.
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
 * The longest pattern read here to be simplified (`simplifiedPattern`), four times the longest run.
 * Reading costs its length, a few times over for the groups it opens, once for each manifest an
 * isolate judges by; no pattern is run that is longer than `MAX_RUN_PATTERN_LENGTH` once simplified.
 */
const MAX_READ_PATTERN_LENGTH = 16_384;

/** How many groups inside one another are opened to simplify what they hold. */
const MAX_OPENED_GROUPS = 8;

/** A `.`, alone or repeated: the fewest characters it takes, and whether it takes any number. */
interface AnyRun {
  readonly fewest: number;
  readonly endless: boolean;
}

/**
 * One piece of an alternative: an anchor, a `.` with its repetition, a group, or any other atom
 * with its quantifier. A group that is not repeated keeps where its alternatives begin, if it is
 * one whose contents are only its alternatives.
 */
interface Piece {
  readonly start: number;
  readonly end: number;
  readonly anchor?: '^' | '$' | undefined;
  readonly any?: AnyRun | undefined;
  readonly contents?: number | undefined;
}

/** The repetition of a `.` whose quantifier is spelled from `from` to `to`, lazy or not. */
function anyRunOf(pattern: string, from: number, to: number): AnyRun {
  const spelled = pattern.slice(from, to - (to - from > 1 && pattern[to - 1] === '?' ? 1 : 0));
  switch (spelled) {
    case '': {
      return { fewest: 1, endless: false };
    }
    case '*': {
      return { fewest: 0, endless: true };
    }
    case '+': {
      return { fewest: 1, endless: true };
    }
    case '?': {
      return { fewest: 0, endless: false };
    }
    default: {
      // `quantifierAt` reads no other spelling of a brace.
      const counts = /^\{(\d+)(?:,(\d*))?\}$/u.exec(spelled);
      return { fewest: Number(counts?.[1] ?? 1), endless: counts?.[2] === '' };
    }
  }
}

/** The pieces of one alternative, or `undefined` where one is not read here. */
function piecesOf(alternative: string): Piece[] | undefined {
  const pieces: Piece[] = [];
  let index = 0;
  while (index < alternative.length) {
    const character = alternative[index];
    if (character === '^' || character === '$') {
      pieces.push({ start: index, end: index + 1, anchor: character });
      index += 1;
      continue;
    }
    const group = character === '(';
    const atomEnd = group ? afterGroup(alternative, index) : atomAt(alternative, index)?.end;
    if (atomEnd === undefined) {
      return undefined;
    }
    const end = quantifierAt(alternative, atomEnd)?.end ?? atomEnd;
    pieces.push({
      start: index,
      end,
      ...(character === '.' && { any: anyRunOf(alternative, atomEnd, end) }),
      ...(group && end === atomEnd && { contents: groupContents(alternative, index) }),
    });
    index = end;
  }
  return pieces;
}

/** The alternatives of a pattern at its own level: `|` inside a group or a set divides nothing. */
function alternativesOf(pattern: string): string[] {
  const alternatives: string[] = [];
  let start = 0;
  let index = 0;
  while (index < pattern.length) {
    switch (pattern[index] ?? '') {
      case '\\': {
        index += 2;
        break;
      }
      case '[': {
        index = afterCharacterClass(pattern, index);
        break;
      }
      case '(': {
        index = afterGroup(pattern, index);
        break;
      }
      case '|': {
        alternatives.push(pattern.slice(start, index));
        index += 1;
        start = index;
        break;
      }
      default: {
        index += 1;
      }
    }
  }
  alternatives.push(pattern.slice(start));
  return alternatives;
}

/** `n` characters of anything, spelled as the fewest `.`s mean. */
function anyOf(fewest: number): string {
  if (fewest === 0) {
    return '';
  }
  return fewest === 1 ? '.' : `.{${String(fewest)}}`;
}

/**
 * How the pieces from `from` run on, taken as runs of anything: the fewest characters between
 * them, whether they take any number, and where the run stops. `step` is 1 forwards, -1 back.
 */
function anyRunFrom(
  pieces: readonly Piece[],
  from: number,
  step: 1 | -1,
  stop: number,
): { readonly fewest: number; readonly endless: boolean; readonly next: number } {
  let fewest = 0;
  let endless = false;
  let next = from;
  while (next !== stop) {
    const run = pieces[next]?.any;
    if (run === undefined) {
      break;
    }
    fewest += run.fewest;
    endless ||= run.endless;
    next += step;
  }
  return { fewest, endless, next };
}

/**
 * Where an alternative's pieces go on past a run of anything that begins it, and the run as it is
 * spelled simplified: after `^`, only a run that takes any number is one.
 */
function leadingRun(pieces: readonly Piece[]): { readonly first: number; readonly head: string } {
  const begun = pieces[0]?.anchor === '^' ? 1 : 0;
  const run = anyRunFrom(pieces, begun, 1, pieces.length);
  return run.next !== begun && (begun === 0 || run.endless)
    ? { first: run.next, head: anyOf(run.fewest) }
    : { first: 0, head: '' };
}

/**
 * Where an alternative's pieces stop before a run of anything that ends it, after `first`, and the
 * run as it is spelled simplified: before `$`, only a run that takes any number is one.
 */
function trailingRun(
  pieces: readonly Piece[],
  first: number,
): { readonly last: number; readonly tail: string } {
  const ended =
    pieces.length > first && pieces.at(-1)?.anchor === '$' ? pieces.length - 1 : pieces.length;
  const run = anyRunFrom(pieces, ended - 1, -1, first - 1);
  return run.next !== ended - 1 && (ended === pieces.length || run.endless)
    ? { last: run.next + 1, tail: anyOf(run.fewest) }
    : { last: pieces.length, tail: '' };
}

/**
 * One alternative simplified to what Next.js's test finds it by: the same agents named, at a cost
 * its shape may bound where the alternative as written was not. Possibly several alternatives, for
 * a group opened.
 *
 * Next.js tests the pattern anywhere in the agent, and a user agent holds no line terminator — a
 * header value cannot — so `.` takes any character of it. An alternative that matches somewhere
 * after `n` characters of anything, at least, matches somewhere after exactly `n`; and one that
 * matches somewhere, then takes `n` characters of anything, matches somewhere with exactly `n`
 * after it. So a run of `.`s that begins the alternative — or begins it after `^`, where the run
 * takes any number — is `.{n}` for the fewest it takes; and one that ends it, or ends it before
 * `$`, the same. `.*bot.*` is `bot`, `^.*bot` is `bot` too, and `.*.*.*.*!` is `!`. A group that
 * is then the whole alternative, repeated no more than once, is its own alternatives, each between
 * the runs that surrounded it — where no backreference can be told apart by the group's number
 * (`opens`).
 */
function simplifiedAlternative(alternative: string, depth: number, opens: boolean): string[] {
  const pieces = piecesOf(alternative);
  if (pieces === undefined) {
    return [alternative];
  }
  const { first, head } = leadingRun(pieces);
  const { last, tail } = trailingRun(pieces, first);
  const middle = pieces.slice(first, last);
  const group = middle.length === 1 ? middle[0] : undefined;
  if (opens && depth < MAX_OPENED_GROUPS && group?.contents !== undefined) {
    const inner = alternative.slice(group.contents, group.end - 1);
    return alternativesOf(inner).flatMap((each) =>
      simplifiedAlternative(`${head}${each}${tail}`, depth + 1, opens),
    );
  }
  const body = alternative.slice(middle[0]?.start ?? 0, middle.at(-1)?.end ?? 0);
  return [`${head}${body}${tail}`];
}

/**
 * The pattern with each of its alternatives simplified (`simplifiedAlternative`): the same agents
 * named, and — for the shapes applications write, `.*bot.*` or `.*(bot|crawler).*` — a pattern the
 * edge runs where the one written is not. An alternative left empty matches every agent, and so
 * does the pattern: it is `''`.
 */
function simplifiedPattern(pattern: string): string {
  // A backreference counts groups; opening one would renumber them. `\1` in a set is no
  // backreference, but a pattern with it is not simplified by opening groups either.
  const opens = !/\\[1-9k]/u.test(pattern);
  const alternatives = alternativesOf(pattern).flatMap((alternative) =>
    simplifiedAlternative(alternative, 0, opens),
  );
  return alternatives.includes('') ? '' : alternatives.join('|');
}

/** The pattern compiled as Next.js compiles it — case-insensitive, without the unicode flag. */
function compiled(pattern: string): RegExp | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
    return new RegExp(pattern, 'i');
  } catch {
    return undefined;
  }
}

/**
 * The application's pattern as the edge judges it, or `undefined` for one it will not run: one
 * that does not compile, or whose simplified form (`simplifiedPattern`) is not of a shape it runs
 * (`runsBounded`). Next.js's own list is read as `isHtmlLimitedBotUserAgent` reads it. What is run
 * is the simplified pattern, which names the agents the one written does.
 */
function judgeOf(pattern: string): BlockingJudge | undefined {
  if (pattern === NEXT_HTML_LIMITED_BOTS) {
    return isHtmlLimitedBotUserAgent;
  }
  // A pattern Next.js could not compile is not run here either, simplified or not.
  if (pattern.length > MAX_READ_PATTERN_LENGTH || compiled(pattern) === undefined) {
    return undefined;
  }
  const simple = simplifiedPattern(pattern);
  const regex = runsBounded(simple) ? compiled(simple) : undefined;
  if (regex === undefined) {
    return undefined;
  }
  return (userAgent) => userAgent.length > MAX_TESTED_USER_AGENT_LENGTH || regex.test(userAgent);
}

/**
 * The judge for a pattern the edge will not run: every agent may be one it names.
 *
 * Such a pattern the Function still runs, and a visitor it names is rendered whole there, with its
 * metadata blocking. No other list stands in for it here. A shell served to a visitor the pattern
 * names would be resumed for that visitor with the blocking tree — the edge forwards the agent —
 * against a postponed state made for the streamed one; React finds the trees differ, renders the
 * resumed boundaries on the client, and a crawler that runs no script is left with no metadata and
 * unfilled fallbacks. So every visitor that names an agent is passed on (`judgesHtmlLimitedBots`
 * says why), and the application loses its shells to all of them rather than its metadata to some.
 * A request that names no agent is still streamed to, as Next.js streams to it whatever the
 * pattern.
 */
const namesEveryAgent: BlockingJudge = () => true;

/** The judge a manifest's list is read by, and whether that list is one the edge runs. */
interface ListJudgement {
  readonly judge: BlockingJudge;
  readonly runs: boolean;
}

/**
 * The application's pattern compiled, once for each manifest that carries it: the same for every
 * request of the deployment, and gone with the manifest.
 */
const judgements = new WeakMap<ProjectManifest, ListJudgement>();

function judgementOf(manifest: ProjectManifest): ListJudgement | undefined {
  const pattern = manifest.htmlLimitedBots;
  if (pattern === undefined || pattern === '') {
    return undefined;
  }
  let judgement = judgements.get(manifest);
  if (judgement === undefined) {
    const judge = judgeOf(pattern);
    judgement =
      judge === undefined ? { judge: namesEveryAgent, runs: false } : { judge, runs: true };
    judgements.set(manifest, judgement);
  }
  return judgement;
}

/**
 * Whether the edge runs the list a manifest's application sends blocking metadata by: Next.js's own
 * where it names none, or its own that compiles and, simplified (`simplifiedPattern`), is of a
 * shape the edge runs (`runsBounded`). Where it does not, `wantsBlockingMetadata` names every
 * agent, and a visitor passed on for that is passed on for the list, not for being named by it.
 */
export function judgesHtmlLimitedBots(manifest: ProjectManifest | undefined): boolean {
  return manifest === undefined || (judgementOf(manifest)?.runs ?? true);
}

/**
 * Whether Next.js may send blocking metadata to this user agent in the application a manifest
 * publishes, and so render its page whole rather than completing a shell. A request that names no
 * agent is streamed to, as Next.js streams to one, whatever the pattern; an empty pattern is none,
 * as Next.js reads it. Under a pattern the edge will not run, every agent may be named, and is
 * (`namesEveryAgent`).
 */
export function wantsBlockingMetadata(
  userAgent: string | null,
  manifest: ProjectManifest | undefined,
): boolean {
  if (userAgent === null || userAgent === '') {
    return false;
  }
  const judgement = manifest === undefined ? undefined : judgementOf(manifest);
  return (judgement?.judge ?? isHtmlLimitedBotUserAgent)(userAgent);
}

/**
 * Why a navigation is passed on for the metadata Next.js may send it blocking: `bot` for a visitor
 * the application's list names, `html-limited-bots` for any that names an agent under a list the
 * edge will not run (`judgesHtmlLimitedBots`) — or `undefined` where it is not: a page the build
 * finished, whose document is what Next.js sends that visitor too, or a visitor it streams to.
 */
export function blockingMetadataReason(
  entry: Pick<RouteEntry, 'cache'> | undefined,
  userAgent: string | null,
  manifest: ProjectManifest | undefined,
): 'bot' | 'html-limited-bots' | undefined {
  if (entry?.cache?.delivery === 'complete' || !wantsBlockingMetadata(userAgent, manifest)) {
    return undefined;
  }
  return judgesHtmlLimitedBots(manifest) ? 'bot' : 'html-limited-bots';
}

/** The pattern Next.js writes into a partially prerendered route's `bypassFor` for this manifest. */
function blockingMetadataPattern(manifest: ProjectManifest): string {
  const pattern = manifest.htmlLimitedBots;
  return pattern === undefined || pattern === '' ? NEXT_HTML_LIMITED_BOTS : pattern;
}

/**
 * Whether a prerender's `bypassFor` holds for a request: any one of its conditions, as Next.js reads
 * the list (`anyConditionHolds`), except the one `next build` writes from `htmlLimitedBots`.
 *
 * `next build` gives every App Router page a user-agent condition whose pattern is the
 * application's list verbatim, or Next.js's own where the application names none — wrapped, from
 * Next.js 16.4, to be found anywhere in the agent (`listWritten`) — whenever partial prerendering
 * is on for its routes, a page it finished included, so that a visitor it sends blocking metadata
 * to skips the shell. Run as a condition, that pattern is tested whole and
 * then anywhere in the agent, with no bound on its shape — before the first byte of every
 * navigation to such a route. It is asked of `wantsBlockingMetadata` instead, the bounded judge
 * that already answers the same question for the classification, so the two cannot disagree
 * either. That judge is case-insensitive where the condition is not, and names every agent under a
 * pattern it will not run, so it passes on at least every visitor the condition does.
 *
 * Of a page the build finished (`delivery: 'complete'`) the condition is not asked at all, as the
 * classification does not ask the judge. Next.js's router does pass such a visitor on, and the
 * page is rendered for it anew; but the page has no part left for a request to render, and its
 * metadata was resolved at build time, into the document, so what that render sends is the
 * finished document. This departs from Next.js knowingly, for the cost of a render.
 *
 * A manifest made before the list was recorded (`htmlLimitedBots` absent) still carries the
 * condition `next build` wrote, under the application's own pattern where it had one. That condition
 * is the list, and the only user-agent condition `next build` writes, so it is judged as the list is
 * — by its own pattern, bounded, case-insensitive, and naming every agent where it will not run —
 * rather than run as written: the same agents passed on as by a manifest that records it.
 *
 * Every other condition — a Server Action's header, a multipart body, or a user-agent condition
 * with another pattern beside a recorded list — is still run as Next.js's router runs it, unbounded
 * in its shape as every `has` and `missing` condition is. Bounding those is separate work.
 */
export function bypassForHolds(
  entry: Pick<RouteEntry, 'bypassFor' | 'cache'>,
  url: URL,
  headers: Headers,
  manifest: ProjectManifest,
): boolean {
  const conditions = entry.bypassFor;
  if (conditions === undefined) {
    return false;
  }
  const pattern = blockingMetadataPattern(manifest);
  const recorded = manifest.htmlLimitedBots !== undefined;
  const finished = entry.cache?.delivery === 'complete';
  return conditions.some((condition) => {
    const listed =
      condition.type === 'header' &&
      condition.key?.toLowerCase() === 'user-agent' &&
      condition.value !== undefined
        ? listWritten(condition.value)
        : undefined;
    if (listed === undefined || (recorded && listed !== pattern)) {
      return anyConditionHolds([condition], url, headers);
    }
    if (finished) {
      return false;
    }
    // A manifest made before the list was recorded: the user-agent condition `next build` wrote is
    // the list, and the only one it writes, so it is judged as one — by its own pattern.
    const agent = headers.get('user-agent');
    return recorded
      ? wantsBlockingMetadata(agent, manifest)
      : wantsBlockingMetadataBy(agent, listed);
  });
}

/** What Next.js 16.4 wraps the list in, as the route's condition: anywhere in the agent. */
const WRAPPED_LIST_PREFIX = '.*(?:';
const WRAPPED_LIST_SUFFIX = ').*';

/**
 * The list a route's user-agent condition was written from. Next.js 16.3 writes the pattern as it
 * is; from 16.4 its route matchers anchor a header's value, so it writes it wrapped to be found
 * anywhere in the agent (`.*(?:pattern).*`), which names the agents the pattern does. Either is the
 * list, and is judged as one rather than run as a condition is.
 */
function listWritten(value: string): string {
  return value.startsWith(WRAPPED_LIST_PREFIX) && value.endsWith(WRAPPED_LIST_SUFFIX)
    ? value.slice(WRAPPED_LIST_PREFIX.length, -WRAPPED_LIST_SUFFIX.length)
    : value;
}

/** The judgements of patterns read off a route's condition, by the pattern: a few per isolate. */
const patternJudgements = new Map<string, ListJudgement>();
const MAX_PATTERN_JUDGEMENTS = 64;

/** Whether this agent is named by a list read off a route's condition (`bypassForHolds`). */
function wantsBlockingMetadataBy(userAgent: string | null, pattern: string): boolean {
  if (userAgent === null || userAgent === '') {
    return false;
  }
  let judgement = patternJudgements.get(pattern);
  if (judgement === undefined) {
    const judge = judgeOf(pattern);
    judgement =
      judge === undefined ? { judge: namesEveryAgent, runs: false } : { judge, runs: true };
    if (patternJudgements.size >= MAX_PATTERN_JUDGEMENTS) {
      patternJudgements.clear();
    }
    patternJudgements.set(pattern, judgement);
  }
  return judgement.judge(userAgent);
}
