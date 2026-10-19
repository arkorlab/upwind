import { MAX_PRELOAD_LINK_LENGTH, MAX_PRELOAD_LINKS } from '@stayingupwind/core/manifest';
import {
  effectiveReferrerPolicy,
  permitsSameOriginFetch,
  type PolicyDestination,
  quietensASameOriginFetch,
} from '@stayingupwind/core/request';

import { asciiLower, scanHead } from './head-scan.ts';

/** The punctuation a `Link` header is written with, which is the markup's punctuation too. */
const TAG_START = '<';
const TAG_END = '>';
const DOUBLE_QUOTE = '"';
const EQUALS = '=';

const STYLESHEET_REL = 'stylesheet';
const PRELOAD_REL = 'preload';
const ALTERNATE_REL = 'alternate';
const STYLE_AS = 'style';
/** The two states a CORS settings attribute has, whatever the markup or a header writes for it. */
const ANONYMOUS = 'anonymous';
const USE_CREDENTIALS = 'use-credentials';
const FONT_AS = 'font';
const REL_ATTR = 'rel';
const AS_ATTR = 'as';
const CROSSORIGIN_ATTR = 'crossorigin';
const TYPE_ATTR = 'type';
const MEDIA_ATTR = 'media';
const DISABLED_ATTR = 'disabled';
const INTEGRITY_ATTR = 'integrity';
const REFERRER_POLICY_ATTR = 'referrerpolicy';
const NONCE_ATTR = 'nonce';
const TITLE_ATTR = 'title';
/**
 * What separates the parts of a key, and stands in for a part that was never written.
 *
 * A character no attribute can carry, so that an attribute cannot be mistaken for the absence of
 * one: a `type` of `-` is not a `type` left out, however little sense it makes.
 */
const NOTHING = '\u{0000}';
const VALUE_SEPARATOR = ',';
const PARAMETER_SEPARATOR = ';';
const BACKSLASH = '\\';
/** What begins a URL's fragment, which the browser keeps and never requests. */
const FRAGMENT = '#';
const FETCH_PRIORITY_ATTR = 'fetchpriority';
/** Media a link is conditional on nothing by: the attribute's own default, written or empty. */
const UNCONDITIONAL_MEDIA: ReadonlySet<string> = new Set(['', 'all']);
/** A run of the whitespace HTML separates things with, for the attributes that hold a list. */
const HTML_SPACE_RUN = /[\t\n\f\r ]+/u;
/** The same characters one at a time, for taking them out of a value rather than splitting on them. */
const HTML_SPACE = /[\t\n\f\r ]/gu;
/** The same characters as a string, for taking them off the ends of a value one at a time. */
const HTML_SPACES = '\t\n\f\r ';
const HREF_ATTR = 'href';
const CSP_HEADER = 'content-security-policy';
const REFERRER_POLICY_HEADER = 'referrer-policy';

interface LinkTag {
  readonly href: string;
  readonly rels: ReadonlySet<string>;
  readonly as: string | undefined;
  readonly crossorigin: string | undefined;
  readonly type: string | undefined;
  /** The media query the link is conditional on, when the markup gave it one. */
  readonly media: string | undefined;
  readonly disabled: boolean;
  /** Whether the markup gives it a title, which makes a stylesheet one of a named set. */
  readonly titled: boolean;
  /** Whether the markup asks for this one to be checked against a digest. */
  readonly integrity: boolean;
  /** Whether the markup fetches this one under a referrer policy of its own. */
  readonly referrerPolicy: boolean;
  /** Whether a policy authorises this one by a nonce the markup carries. */
  readonly nonce: boolean;
  /** Whether the markup asks for this one at a priority of its own. */
  readonly fetchPriority: boolean;
}

/** Take off both ends whatever `drop` names, which is what a parser does before it reads a value. */
function trimEdges(value: string, drop: (character: string) => boolean): string {
  let start = 0;
  let end = value.length;
  while (start < end && drop(value[start] ?? '')) {
    start += 1;
  }
  while (end > start && drop(value[end - 1] ?? '')) {
    end -= 1;
  }
  return value.slice(start, end);
}

/**
 * Only the whitespace HTML separates things by, which `String.trim` is not.
 *
 * `trim` takes the whole of Unicode's whitespace off, and a no-break space is a character of a
 * value rather than a space around it: `rel="\u{A0}stylesheet"` is a relation no browser has ever
 * heard of and a stylesheet it never loads, and a scan that trimmed it would send a hint for one.
 */
function htmlTrim(value: string): string {
  return trimEdges(value, (character) => HTML_SPACES.includes(character));
}

function relsOf(value = ''): ReadonlySet<string> {
  const rels = new Set<string>();
  // The whitespace HTML separates them by, not just the space they are usually written with. The
  // split leaves nothing around a token that needs taking off: a run of it is one separator, and
  // what a run leaves at either end is the empty string below.
  const parts = value.split(HTML_SPACE_RUN);
  for (const part of parts) {
    const rel = asciiLower(part);
    if (rel !== '') {
      rels.add(rel);
    }
  }
  return rels;
}

/** `asciiLower` for a value that may not be there at all. */
function asciiLowerOf(value: string | undefined): string | undefined {
  return value === undefined ? undefined : asciiLower(value);
}

/**
 * The href as the browser will read it, or `undefined` when this cannot read it the same way.
 *
 * A tokenizer resolves every character reference in an attribute, and there are hundreds of them.
 * `&amp;` is the one worth reading, because a query string is written with it; anything else with
 * an `&` in it is a URL this would repeat as something other than the file the page asks for —
 * `/styles&#47app.css` is `/styles/app.css` to a browser and a different file to a header.
 */
function decodedHref(href: string): string | undefined {
  const parts = href.split('&amp;');
  return parts.some((part) => part.includes('&')) ? undefined : parts.join('&');
}

function parseLinkTag(attributes: ReadonlyMap<string, string>): LinkTag | undefined {
  const href = attributes.get(HREF_ATTR);
  if (href === undefined || href === '') {
    return undefined;
  }
  // A reference in the relation is one this does not read either, and there it would hide a word:
  // `rel="stylesheet alternate&#32;"` is an alternate stylesheet to a browser and an unconditional
  // one to a scan that splits the raw value.
  const rel = attributes.get(REL_ATTR) ?? '';
  if (rel.includes('&')) {
    return undefined;
  }
  // And in the mode it is fetched in, where it would hide the second of the two states:
  // `crossorigin="use&#45;credentials"` is the credentialed one to a browser, and a hint naming
  // the anonymous one is a request the markup's own cannot be answered by.
  const crossorigin = attributes.get(CROSSORIGIN_ATTR);
  if (crossorigin?.includes('&') === true) {
    return undefined;
  }
  const decoded = decodedHref(href);
  if (decoded === undefined) {
    return undefined;
  }
  return {
    href: decoded,
    rels: relsOf(rel),
    as: asciiLowerOf(attributes.get(AS_ATTR)),
    crossorigin: corsSetting(crossorigin),
    type: attributes.get(TYPE_ATTR),
    media: asciiLowerOf(attributes.get(MEDIA_ATTR)),
    disabled: attributes.has(DISABLED_ATTR),
    titled: (attributes.get(TITLE_ATTR) ?? '') !== '',
    integrity: attributes.has(INTEGRITY_ATTR),
    referrerPolicy: (attributes.get(REFERRER_POLICY_ATTR) ?? '') !== '',
    nonce: (attributes.get(NONCE_ATTR) ?? '') !== '',
    fetchPriority: (attributes.get(FETCH_PRIORITY_ATTR) ?? '') !== '',
  };
}

/**
 * Whether the browser loading this page would fetch the link at all.
 *
 * A stylesheet the markup made conditional is one the page deliberately kept off the critical
 * path. `media="print"` is how a sheet is loaded without blocking the paint, an `alternate` is one
 * the reader has to pick, and `disabled` is one that is never applied. Promoting any of them would
 * fetch at preload priority exactly what the page asked not to race, in front of the stylesheets
 * that do block it. The condition is not carried over to the header instead, because a media query
 * may contain the comma that separates one `Link` value from the next.
 */
function isActiveLink(tag: LinkTag): boolean {
  if (tag.disabled || tag.rels.has(ALTERNATE_REL) || inStyleSheetSet(tag)) {
    return false;
  }
  return unconditional(tag.media);
}

/**
 * Whether a `title` makes this stylesheet one of a named set.
 *
 * A set is applied only while it is the one the document prefers: the first titled sheet's, until
 * a `<meta http-equiv="default-style">` names another — which one may do anywhere in the document,
 * the body included. A sheet of any other set is never applied, and the head alone cannot say which
 * set that will be, so a titled sheet is left to the markup. An empty `title` names no set, and a
 * preload's names none at all: those are fetched whatever the document prefers.
 */
function inStyleSheetSet(tag: LinkTag): boolean {
  return tag.titled && tag.rels.has(STYLESHEET_REL);
}

/**
 * Whether a `media` restricts what it is written on, or is the default it may as well omit.
 *
 * The whitespace a CSS parser drops around a query is the same whitespace HTML separates by, and
 * nothing wider: a no-break space makes `all` into a query that names no media type at all, which
 * is a sheet the page loads at the priority of something it is not waiting for.
 */
function unconditional(media: string | undefined): boolean {
  // Folded here rather than by the caller: a media type is read without case wherever it is
  // written, and a header's `media=ALL` is the `all` the markup's own value is read as.
  return media === undefined || UNCONDITIONAL_MEDIA.has(asciiLower(htmlTrim(media)));
}

/**
 * A path on this origin, and nothing else. A third-party stylesheet is the application's to
 * discover, and `//host/x` is another origin written to look like a path — the same rule a
 * recorded language redirect is held to.
 */
function isSameOriginPath(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

/**
 * The characters an href may bring into a header value: the ones RFC 3986 gives a URI, less the
 * two that already mean something in a `Link`. A parser that reads the grammar keeps a `,` or a
 * `;` inside the angle brackets, and one that splits the header on them first does not — and this
 * header is read by every hop between here and the browser, one of which replays it as a `103`.
 * A URL this cannot be sure survives the journey is one it does not send a hint for; the file is
 * still named in the markup, where nothing has to parse a header to find it.
 *
 * Everything outside the set is left out by construction, which is the point: a space is not part
 * of a URI, and a control character is refused outright when the header is set, taking down every
 * response for the route long after the proof that recorded it. A shell is the origin's to write;
 * what this turns it into is the edge's to answer.
 *
 * And only where the grammar puts them, since a hop that parses the reference may drop one it
 * cannot read: a `%` begins an escape of two hex digits, a `#` the one fragment there is, and `[`
 * and `]` belong to the host of an IP literal, which a path on this origin has none of. A browser
 * fetches `/asset%zz.css` all the same; a header that names it is one nothing promises to carry.
 */
const SAFE_HREF =
  /^(?:[\w!$&'()*+./:=?@~-]|%[\dA-Fa-f]{2})+(?:#(?:[\w!$&'()*+./:=?@~-]|%[\dA-Fa-f]{2})*)?$/u;
/** What this will quote into a parameter: a media type, and nothing that is not shaped like one. */
const SAFE_TOKEN = /^[\w+./-]*$/u;
/** A URL that names its own scheme, and so its own origin. */
const ABSOLUTE_URL = /^[a-z][\w+.-]*:/iu;
/** A URL that takes the document's scheme and names its own host. */
const PROTOCOL_RELATIVE = '//';
/** The last of the C0 controls, which a URL parser strips from both ends of what it is given. */
const LAST_CONTROL = 0x1f;

/**
 * The mode `crossorigin` asks for, which is one of two things however the value is written.
 *
 * It is an enumerated attribute, and only `use-credentials` in some casing is the second of them:
 * `ANONYMOUS`, the empty string a boolean attribute leaves behind, and a word that means nothing
 * are all the anonymous state. Only leaving the attribute out is no CORS at all. Read as written
 * instead, a `crossorigin="ANONYMOUS"` would be a second hint for the request the origin's header
 * already names, and one of the few values this may send spent on it.
 */
function corsSetting(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  // No trimming: the keyword is matched as it stands, so ` use-credentials` is not one and lands
  // in the anonymous state with everything else a browser does not recognise.
  return asciiLower(value) === USE_CREDENTIALS ? USE_CREDENTIALS : ANONYMOUS;
}

/**
 * `crossorigin` as a preload parameter, empty when the markup named no mode at all.
 *
 * A preload is only the request the page goes on to make if it is made the same way, and this
 * attribute is what decides that: a stylesheet the markup fetches in CORS mode and a preload that
 * does not say so are two downloads of one file, the first of them in front of the paint.
 */
function crossoriginParameter(tag: LinkTag): string {
  if (tag.crossorigin === undefined) {
    return '';
  }
  return `; ${CROSSORIGIN_ATTR}="${tag.crossorigin}"`;
}

/** `type` the same way: nothing when the markup gave none, `undefined` when it cannot be quoted. */
function typeParameter(tag: LinkTag): string | undefined {
  if (tag.type === undefined) {
    return '';
  }
  return SAFE_TOKEN.test(tag.type) ? `; ${TYPE_ATTR}="${tag.type}"` : undefined;
}

/**
 * The value a `Link` carries for one of these, or `undefined` when the markup's own attributes
 * cannot be reproduced in a header.
 *
 * A preload is the request the page goes on to make only if it is made the same way. `crossorigin`
 * decides the mode it is fetched in, and `type` decides whether it is fetched at all: a browser
 * skips a format it cannot use, and a hint that drops the type it was told would have it fetch
 * what the markup had already excused it from.
 */
function preloadValue(tag: LinkTag, asKind: string): string | undefined {
  const type = typeParameter(tag);
  if (type === undefined) {
    return undefined;
  }
  return `<${tag.href}>; rel=${PRELOAD_REL}; as=${asKind}${crossoriginParameter(tag)}${type}`;
}

/**
 * What the browser would fetch this link as, of the two destinations worth promoting.
 *
 * Also what makes one preload another's equal: a preload names a destination, and the same file
 * preloaded as a script is not the stylesheet request a page is waiting on.
 */
function preloadDestination(tag: LinkTag): string | undefined {
  if (tag.rels.has(STYLESHEET_REL)) {
    return STYLE_AS;
  }
  if (!tag.rels.has(PRELOAD_REL)) {
    return undefined;
  }
  return tag.as === STYLE_AS || tag.as === FONT_AS ? tag.as : undefined;
}

function preloadFor(tag: LinkTag): string | undefined {
  if (!isSameOriginPath(tag.href) || !SAFE_HREF.test(tag.href) || !isActiveLink(tag)) {
    return undefined;
  }
  // Four things a header cannot carry the way the markup wrote them. Subresource integrity is
  // part of what a browser matches a preload against, and the markup may write a list of digests —
  // a value this would have to quote with its spaces intact. A referrer policy is not a parameter
  // a `Link` is read for at all, so the hint would start the request under the document's policy
  // and send a `Referer` the markup had suppressed. And a nonce is what a policy naming one
  // authorises the fetch by: a header-borne request carries none, so a policy that names nothing
  // else would block it and report a violation for the trouble. And a fetch priority is the page
  // saying where this belongs in the queue, which a hint sent at the default would contradict —
  // starting something asked for last against the stylesheets this exists to get started first.
  // A hint that cannot reproduce the request is a download the page cannot use, so each of them
  // leaves the link where it was.
  if (tag.integrity || tag.referrerPolicy || tag.nonce || tag.fetchPriority) {
    return undefined;
  }
  const destination = preloadDestination(tag);
  if (destination === undefined) {
    return undefined;
  }
  // A font is fetched in CORS mode whatever the page does, so a markup preload with no
  // `crossorigin` is that mistake already made: repeating it on the header would only move the
  // wasted download in front of what blocks the paint, and adding the attribute the markup does
  // not have would make a third request nothing on the page can use.
  if (destination === FONT_AS && tag.crossorigin === undefined) {
    return undefined;
  }
  return preloadValue(tag, destination);
}

/**
 * The URL a parser would see: the C0 controls it strips off both ends taken off here as well.
 *
 * `\u{1}//cdn.example/` is `//cdn.example/` to it, and a scan that reads the control as the first
 * character of a path would call that base a path. Written a character at a time rather than as a
 * pattern, because a regular expression is no place to keep control characters.
 */
function withoutEdgeControls(value: string): string {
  return trimEdges(value, (character) => (character.codePointAt(0) ?? 0) <= LAST_CONTROL);
}

/**
 * Whether a `<base>` sends the markup's own URLs somewhere this header cannot follow.
 *
 * `/app.css` under `<base href="https://cdn.example/">` is a file on that host, while the same
 * path on a `Link` header is a file on the one that answered: a header resolves against the
 * request, and the document's base never reaches it. So the paths a head names after it moves its
 * own origin are paths this cannot repeat, and they are left to say what they mean on their own.
 * Those it named before are not: a parser had fetched them against the document's URL before the
 * base was there, and a link already fetched is not fetched again for it.
 *
 * Read as written. A tokenizer resolves the character references in an attribute before the URL is
 * parsed, so `https&#58;//cdn.example/` is that same other host, and a base carrying a reference
 * this does not read is one it cannot be sure of. A base that only moves the path — `/app/`,
 * `./`, `../assets/` — moves no origin at all, and the paths this promotes are absolute ones a
 * base path does not touch, so those heads keep their hints.
 */
function movesTheOrigin(base: string | undefined): boolean {
  if (base === undefined) {
    return false;
  }
  // The URL parser drops the ASCII whitespace inside a URL, so a scheme written through it is
  // still a scheme; taken out here, what is left is what the document will resolve against. The
  // controls it strips from the ends go the same way: a `//host/` written behind one is still that
  // host, and a base whose leading character this kept would read as a path that moves nothing.
  const declared = withoutEdgeControls(base.replaceAll(HTML_SPACE, ''));
  if (declared === '') {
    return false;
  }
  // A reference this does not read could spell either of the two things below.
  if (declared.includes('&')) {
    return true;
  }
  // A backslash is a slash to a URL parser, so `\\host/` is the second of them too.
  const opening = declared.slice(0, PROTOCOL_RELATIVE.length).replaceAll('\\', '/');
  return opening === PROTOCOL_RELATIVE || ABSOLUTE_URL.test(declared);
}

/**
 * The hrefs the origin's own `Link` already asks the browser to preload.
 *
 * Its relation, not just its href: the same file may be named there as something else entirely —
 * a `rel=canonical`, a `rel=prefetch` for the next page — and none of those start the fetch a
 * preload starts. Treating one as this hint's equal would leave a render-blocking resource
 * advertised as nothing of the kind.
 */
function advertisedPreloads(header: string | undefined): ReadonlySet<string> {
  const advertised = new Set<string>();
  if (header === undefined) {
    return advertised;
  }
  for (const value of splitOutsideQuotes(header, VALUE_SEPARATOR)) {
    // A link-value opens with its reference, and one that does not is a value a parser skips
    // whole: `junk</app.css>; rel=preload` advertises nothing to the browser, and reading the
    // reference out of the middle of it would stand a hint down for a preload nobody sent.
    //
    // Every other parameter of a value that does open with one is read, `anchor` included: the
    // algorithm a browser processes a `Link` header by has no step for it, so a value carrying
    // one preloads for this document like any other, and passing over it would send the file a
    // second time.
    const declared = htmlTrim(value);
    const end = declared.startsWith(TAG_START) ? declared.indexOf(TAG_END, TAG_START.length) : -1;
    if (end === -1) {
      continue;
    }
    // And what follows the reference is parameters or nothing: `</app.css>junk; rel=preload` is a
    // value the grammar does not describe, which a parser passes over whole — reading its `rel`
    // would stand a hint down for a preload the browser was never told about.
    const parameters = htmlTrim(declared.slice(end + TAG_END.length));
    if (parameters !== '' && !parameters.startsWith(PARAMETER_SEPARATOR)) {
      continue;
    }
    if (!relsOf(parameterValue(parameters, REL_ATTR)).has(PRELOAD_REL)) {
      continue;
    }
    const shape = {
      destination: asciiLowerOf(parameterValue(parameters, AS_ATTR)) ?? '',
      crossorigin: corsSetting(parameterValue(parameters, CROSSORIGIN_ATTR)),
      type: parameterValue(parameters, TYPE_ATTR),
    };
    // Only an unconditional one stands in. A `media` the device does not match is a preload the
    // browser skips, and skipping it is not fetching the file the markup asks for outright.
    if (unconditional(parameterValue(parameters, MEDIA_ATTR))) {
      advertised.add(preloadKey(shape, declared.slice(TAG_START.length, end)));
    }
  }
  return advertised;
}

/**
 * Split on a separator that is not inside a quoted parameter.
 *
 * A `Link` value's parameters may be quoted strings, and a quoted string may hold anything — a
 * comma, a semicolon, another `<…>`. Splitting on the character alone reads one header's `title`
 * as a second link, and a link nobody sent is one this would give way to for nothing.
 *
 * The angle brackets around a URI hold the same licence, and this does not honour it: `</a,b.css>`
 * is one reference to a parser and two values here, both of which are then dropped for holding no
 * `<…>` of their own. Nothing is lost by that — an href with a comma in it is one this sends no
 * hint for (`SAFE_HREF`), so a value it splits is a value it could not have duplicated, and the
 * ones on either side of it are read as they stand.
 */
function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let at = 0; at < value.length; at += 1) {
    const character = value[at];
    if (quoted && character === BACKSLASH) {
      at += 1;
    } else if (character === DOUBLE_QUOTE) {
      quoted = !quoted;
    } else if (character === separator && !quoted) {
      parts.push(value.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/**
 * What makes two preloads the same one: the file, what the browser would fetch it as, and whether
 * it would fetch it in CORS mode.
 *
 * The file as it is requested. A fragment never leaves the browser, so `/app.css#one` and
 * `/app.css#two` are one fetch: they take one of the values a header carries between them, and a
 * header's own `</app.css>` stands in for both.
 *
 * The mode is part of what a preload is matched on, and `crossorigin` is what sets it — absent is
 * not the same as written, which is why one the markup never wrote is spelled differently here
 * rather than folded in with the anonymous state. A font the header names without it cannot answer
 * the markup's own request, so it does not stand in for the hint that can. What was written is
 * read as the state it names (`corsSetting`), so the two spellings of one mode are one key.
 *
 * `type` decides whether the fetch happens at all, and differs the same way. A media type is
 * compared by its essence without case, so `TEXT/CSS` is the `text/css` request; the parameters
 * behind that essence are not all compared the same way, so they are kept as written — folding the
 * whole of it would put two requests under one key and send the hint for only one of them. The
 * parts are joined on a character no attribute can hold, so no value can be read as the absence of
 * one.
 */
function preloadKey(shape: PreloadShape, href: string): string {
  const fragment = href.indexOf(FRAGMENT);
  const requested = fragment === -1 ? href : href.slice(0, fragment);
  return [shape.destination, shape.crossorigin ?? NOTHING, typeKey(shape.type), requested].join(
    NOTHING,
  );
}

/** A `type` as a key holds it: the essence folded, as a browser reads it, and the rest as written. */
function typeKey(type: string | undefined): string {
  if (type === undefined) {
    return NOTHING;
  }
  const parameters = type.indexOf(PARAMETER_SEPARATOR);
  return parameters === -1
    ? asciiLower(type)
    : asciiLower(type.slice(0, parameters)) + type.slice(parameters);
}

/** What a preload is, beside the file: what it would be fetched as, and how. */
interface PreloadShape {
  readonly destination: string;
  readonly crossorigin: string | undefined;
  readonly type: string | undefined;
}

/**
 * A quoted string as the parser reading it sees it: each `\` is the character behind it.
 *
 * `rel="pre\load"` is `preload` to a parser and a relation of its own to a reader that keeps the
 * backslash — which would leave the header advertising a preload this could not match, and this
 * sending a second hint for what it already named.
 */
function unescaped(value: string): string {
  let out = '';
  for (let at = 0; at < value.length; at += 1) {
    const character = value[at] ?? '';
    if (character === BACKSLASH && at + 1 < value.length) {
      at += 1;
      out += value[at] ?? '';
      continue;
    }
    out += character;
  }
  return out;
}

/**
 * One parameter of a `Link` value, quoted or not, or `undefined` when it names none.
 *
 * A parameter may be written without a value, which the grammar allows and a header uses: the
 * `crossorigin` of an anonymous preload is usually spelled that way. It is the empty value, not
 * a parameter that is not there — read as absent, an advertised `; crossorigin` would key as a
 * request made in no CORS mode at all, and stand in for the hint that really is one.
 */
function parameterValue(parameters: string, name: string): string | undefined {
  for (const parameter of splitOutsideQuotes(parameters, PARAMETER_SEPARATOR)) {
    const at = parameter.indexOf(EQUALS);
    const named = asciiLower(htmlTrim(at === -1 ? parameter : parameter.slice(0, at)));
    if (named !== name) {
      continue;
    }
    if (at === -1) {
      return '';
    }
    const value = htmlTrim(parameter.slice(at + 1));
    // What the quotes hold is the value, commas and all: the header was split on the ones outside
    // them, so one still here was written inside them and is a character of what it names. An `as`
    // of `style,` is not the destination `style`, and reading it as one would let a header that
    // names no usable preload take the place of the hint that does.
    return value.startsWith(DOUBLE_QUOTE) && value.endsWith(DOUBLE_QUOTE) && value.length > 1
      ? unescaped(value.slice(1, -1))
      : value;
  }
  return undefined;
}

/**
 * How many a scan holds before the header has had its say.
 *
 * A caller that knows what the route already advertises is given `MAX_PRELOAD_LINKS` of what is
 * left. One that scans first and deduplicates later — the hosted path, which reads a shell before
 * it knows the route's headers — needs room for the ones that header will take out.
 */
const NOTHING_ADVERTISED: ReadonlySet<string> = new Set();
const SCANS_PER_RECORDED = 4;
const MAX_SCANNED_LINKS = MAX_PRELOAD_LINKS * SCANS_PER_RECORDED;

/**
 * The values of `shellPreloadLinks` minus any the origin's own `Link` already preloads as the same
 * thing, and then as many of those as a header should carry — for a caller that read the shell
 * before it knew what that header would say.
 */
export function withoutAdvertised(
  links: readonly string[],
  advertised: string | undefined,
): string[] {
  const already = advertisedPreloads(advertised);
  const kept =
    already.size === 0 ? [...links] : links.filter((link) => !already.has(keyOfValue(link)));
  // Counted after the header has taken what it already sends, not before: what a route records is
  // what it will advertise, and a head whose first few are spoken for still has the rest to name.
  return kept.slice(0, MAX_PRELOAD_LINKS);
}

/** The key of a `Link` value this wrote: the same one `advertisedPreloads` reads out of a header. */
function keyOfValue(link: string): string {
  const end = link.indexOf(TAG_END);
  const parameters = link.slice(end + 1);
  return preloadKey(
    {
      destination: asciiLowerOf(parameterValue(parameters, AS_ATTR)) ?? '',
      crossorigin: corsSetting(parameterValue(parameters, CROSSORIGIN_ATTR)),
      type: parameterValue(parameters, TYPE_ATTR),
    },
    link.slice(TAG_START.length, end),
  );
}

/**
 * What to record for a proved route: the render-blocking resources a shell's own `<head>` names,
 * as `Link` values, minus anything the origin's own stable header already advertises, and bounded
 * so the header stays a header.
 *
 * A browser finds a stylesheet written in the markup only once it has parsed its way to it, and
 * the shell's bytes cannot be changed to help: they are what the origin's prefix is compared
 * against. The same hrefs on the response's `Link` header ride with the headers instead — which is
 * time to first byte — and are what Cloudflare's Early Hints cache replays ahead of the Worker.
 *
 * Read here, once, from the bytes the route was proved on: the shell is content-addressed, so this
 * is a pure function of it, and the edge has no business parsing HTML in front of a first byte.
 *
 * Only stylesheets and fonts, and only where the page blocks on them. Images and scripts are named
 * in the head too, and promoting those would have the browser contend for bandwidth with the
 * resources that actually block the paint.
 */
export function shellPreloadLinks(shell: Uint8Array, advertised: string | undefined): string[] {
  // Counted as they are collected, so what the header already sends is never one of the six: the
  // scan carries on past it until it has that many the header does not already name.
  return collectPreloads(shell, advertisedPreloads(advertised), MAX_PRELOAD_LINKS);
}

/**
 * Every link a head names that is worth promoting, in the order it names them.
 *
 * For a caller that cannot deduplicate yet because it does not know what the route's own headers
 * say — the hosted path, which reads a shell as the build's files are imported. It collects more
 * than a header will carry, so `withoutAdvertised` still has some left after taking its share; a
 * head that names more than this and has every one of them advertised is past what this chases.
 */
export function scanPreloadLinks(shell: Uint8Array): string[] {
  return collectPreloads(shell, NOTHING_ADVERTISED, MAX_SCANNED_LINKS);
}

/** The links a head names, minus the ones `already` covers, up to `limit` of what is left. */
function collectPreloads(shell: Uint8Array, already: ReadonlySet<string>, limit: number): string[] {
  const scan = scanHead(shell);
  const named = movesTheOrigin(scan.base) ? scan.links.slice(0, scan.linksBeforeBase) : scan.links;
  const seen = new Set<string>();
  const links: string[] = [];
  for (const attributes of named) {
    if (links.length >= limit) {
      break;
    }
    const tag = parseLinkTag(attributes);
    const link = tag === undefined ? undefined : preloadFor(tag);
    if (tag === undefined || link === undefined || link.length > MAX_PRELOAD_LINK_LENGTH) {
      continue;
    }
    // Keyed on what the link produced, not on the file alone: the same file named twice, once as
    // something this promotes and once as something it does not, is still worth promoting.
    const key = preloadKey(
      { destination: preloadDestination(tag) ?? '', crossorigin: tag.crossorigin, type: tag.type },
      tag.href,
    );
    if (seen.has(key) || already.has(key)) {
      continue;
    }
    seen.add(key);
    links.push(link);
  }
  return links;
}

/** What a hint would be fetched as, read back off the value this wrote. */
function destinationOf(link: string): PolicyDestination {
  const end = link.indexOf(TAG_END);
  return parameterValue(link.slice(end + 1), AS_ATTR) === FONT_AS ? FONT_AS : STYLE_AS;
}

/**
 * The hints a route's own headers leave standing.
 *
 * A hint is the request the page goes on to make, or it is not worth sending — which is why a
 * link the markup gives a `referrerpolicy` or a nonce is never promoted. The same statements are
 * made over the whole document in its headers, and they reach a `103` too late to be obeyed:
 * Cloudflare replays the `Link` values alone, before this Worker runs, so the fetch starts under
 * neither the policy that would have blocked it nor the one that would have quietened it.
 *
 * So the judgement is made here, where the route's headers were recorded, rather than over the
 * headers a response finally carries — reading a policy per request is work in front of the first
 * byte, which is the one thing this path does not do.
 */
export function withoutForbidden(
  links: readonly string[],
  headers: Readonly<Record<string, string>>,
): string[] {
  if (quietensASameOriginFetch(effectiveReferrerPolicy(headers[REFERRER_POLICY_HEADER] ?? null))) {
    return [];
  }
  const policy = headers[CSP_HEADER];
  if (policy === undefined) {
    return [...links];
  }
  return links.filter((link) => permitsSameOriginFetch(policy, destinationOf(link)));
}
