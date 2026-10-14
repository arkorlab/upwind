import { metaReferrerPolicy, quietensASameOriginFetch } from '@stayingupwind/core/request';
import { decodeUtf8 } from '@stayingupwind/core/util';

/**
 * Reading a shell's `<head>` the way a parser reads it.
 *
 * A shell is the origin's to write, and every place a scan and an HTML parser disagree about the
 * same bytes is a resource named to a browser that the document never asked for. So this walks the
 * markup once, left to right, in the states the tokenizer has: a tag's attributes read quote-aware,
 * an element whose content is not markup stepped over whole, a template read but inert, and the
 * head ended where a parser would end it.
 */

const KIB = 1024;
const HEAD_SCAN_KIB = 32;
/** A head is a few kilobytes; scanning past this is not reading a head, it is reading a body. */
const HEAD_SCAN_BYTES = HEAD_SCAN_KIB * KIB;
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
/** The other end a tokenizer accepts, and the dash a comment that closes at once may carry. */
const COMMENT_CLOSE_BANG = '--!>';
const COMMENT_DASH = '-';
/**
 * Elements whose contents no parser reads as markup.
 *
 * A `<link>` written inside one of these is text: a string in a bootstrap script, an example in a
 * `<template>`, a page title. Promoting it would have every visitor fetch something the document
 * never referenced, so the scan steps over these the way it steps over a comment.
 *
 * `noscript` is raw text to a parser with scripting enabled, which is the parse this reads. To one
 * without it the element holds markup, so a stylesheet written inside it is loaded there and not
 * here — a hint this does not send, which is the safe half of the difference. The other half needs
 * a comment opened inside the element and closed past its end tag, where the two parses disagree
 * about what is inside the comment; a visitor without scripting then fetches one file of this
 * origin that their document does not use. Ending the walk at every `<noscript>` instead would
 * take the hints under it from every visitor, for markup only written on purpose.
 */
const OPAQUE_ELEMENTS: ReadonlySet<string> = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);
const SCRIPT_NAME = 'script';
const PLAINTEXT_NAME = 'plaintext';
/**
 * A template's contents are markup, unlike the elements above, and inert: a parser reads them into
 * a fragment nothing loads from. So the walk reads them the same way it reads everything else and
 * promotes nothing out of them — which is also the only way to know where the template ends, since
 * an end tag it quotes in an attribute ends nothing.
 */
const TEMPLATE_NAME = 'template';
const BASE_NAME = 'base';
const SELF_CLOSING = '/';
/**
 * Where the markup stops being HTML.
 *
 * A head holds neither, so the walk only meets one inside a template, where it promotes nothing
 * anyway. What it cannot do there is read on the way a parser does. In SVG and MathML a `<style>`
 * or a `<title>` holds markup rather than text, unless an integration point above it makes it
 * HTML again; `<![CDATA[` opens a section; and `</svg>` or `</math>` leaves the element only where
 * nothing HTML is open beneath it, and a `</math>` never leaves an `<svg>`. All of that turns on
 * the stack of open elements, which is a tree builder's, not a walk's.
 *
 * So the walk does not try to say where the foreign element ends. The template around it is what
 * ends it for certain — its end tag pops everything opened inside — and until then the walk ends
 * at whatever it would read otherwise than a parser, rather than guess which reading holds.
 */
const FOREIGN_ROOTS: ReadonlySet<string> = new Set(['math', 'svg']);
/** What can follow a `<` and still not be text: a declaration, a processing instruction, an end tag. */
const MARKUP_DECLARATION: ReadonlySet<string> = new Set(['!', '/', '?']);
const DOCTYPE_OPEN = '<!doctype';
/**
 * A doctype that names a public or system identifier, read over what follows the word `doctype`.
 *
 * The keyword has to stand where a tokenizer looks for it — the whole word, after the name, with
 * a quote behind it — because anywhere else it is a character of a malformed doctype, and a
 * malformed doctype still ends at its first `>`. A name of `systemfoo` declares nothing; nor does
 * a `public` that is the name itself, one written past the name, or one with anything but a quote
 * after it. Reading any of them as an identifier steps over the `>` that ended the declaration,
 * and over the markup behind it.
 */
const DOCTYPE_IDENTIFIER =
  /^[\t\n\f\r ]*[^\t\n\f\r ]+[\t\n\f\r ]+(?:public|system)(?=[\t\n\f\r ]*["'])/u;
/** The keyword that lets a doctype name two identifiers rather than one, and how many that is. */
const DOCTYPE_PUBLIC = 'public';
const PUBLIC_AND_SYSTEM = 2;
/**
 * A CDATA section, which the spec spells in capitals and ends at `]]>` rather than at a `>`.
 *
 * Which of those two it is depends on the element the tokenizer is under at that moment, not on
 * the element it is inside: `<![CDATA[` opens a section only while the adjusted current node is
 * foreign, and an integration point — `<foreignObject>` in SVG, `<mtext>` in MathML — puts an HTML
 * element back on top without leaving the `<svg>`. There the same characters open a bogus comment
 * that ends at the first `>`. Telling the two apart takes the stack of open elements and their
 * namespaces, which is a tree builder; this is a walk that counts how deep it is.
 *
 * So wherever the walk may be in foreign content, it ends here instead of guessing, because both
 * guesses are wrong somewhere: a section read as a comment hands it markup a browser never sees,
 * and a comment read as a section steps over markup a browser does — including the `<body>` that
 * would have ended the head. What ending costs is the hints a head might still have named after
 * its SVG, which no shell writes.
 */
const CDATA_OPEN = '<![CDATA[';
const LINK_NAME = 'link';
const META_NAME = 'meta';
const HTTP_EQUIV_ATTR = 'http-equiv';
const NAME_ATTR = 'name';
const CONTENT_ATTR = 'content';
/** The one `http-equiv` that stops this walk, spelled as a tokenizer folds it. */
const POLICY_EQUIV = 'content-security-policy';
/** And the one `name`, which hands the document a referrer policy the same way. */
const REFERRER_NAME = 'referrer';
/**
 * The end tags a head is closed by rather than ignored for.
 *
 * A tree builder reprocesses each of these after closing the head; every other stray end tag in a
 * head is a parse error it passes over. So a `<link>` written after one of them is the body's.
 */
const CLOSES_THE_HEAD: ReadonlySet<string> = new Set(['body', 'br', 'head', 'html']);
/**
 * The elements the walk passes through on its way into a head, and the ones a head may hold.
 *
 * Anything else closes the head, written or not: `<body>` says so outright, and a `<p>` before one
 * says the same by being somewhere a head cannot keep it. A stylesheet the body names is not one
 * the head asks for, and promoting it would race what does block the paint.
 *
 * The list is what the "in head" insertion mode has a rule for, legacy included: `basefont` and
 * `bgsound` are void elements it keeps, `noframes` is raw text it keeps. A head is free to hold
 * one, and a walk that ended there would leave every stylesheet written after it unnamed.
 */
const BEFORE_THE_BODY: ReadonlySet<string> = new Set([
  'base',
  'basefont',
  'bgsound',
  'head',
  'html',
  'link',
  'meta',
  'noframes',
  'noscript',
  'script',
  'style',
  'template',
  'title',
]);
const HREF_ATTR = 'href';
const DOUBLE_QUOTE = '"';
const SINGLE_QUOTE = "'";
const EQUALS = '=';
const TAG_END = '>';
const TAG_START = '<';
/** The whitespace HTML separates things with. */
const ASCII_SPACES = ' \t\n\f\r';
/**
 * What a tag name may end at: that whitespace, `/` or `>`.
 *
 * `</scripture>` does not close a script and `</header>` does not close a head; both are text a
 * document is allowed to contain, and reading either as an end tag hands the scan markup nobody
 * wrote.
 */
const ENDS_A_TAG_NAME: ReadonlySet<string> = new Set(
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- every one of these is ASCII, so a UTF-16 unit is a character; deriving the set is what keeps it from drifting from the whitespace above.
  [...ASCII_SPACES, '/', TAG_END],
);
/** What ends an attribute name: the whitespace and `/` `>` a tag name ends at, and `=`. */
const ENDS_AN_ATTRIBUTE_NAME: ReadonlySet<string> = new Set([...ENDS_A_TAG_NAME, EQUALS]);
const UPPER_START = 65;
const UPPER_END = 90;
const LOWER_START = 97;
const LOWER_END = 122;
interface ReadValue {
  readonly value: string;
  readonly next: number;
}
/**
 * Fold the ASCII and nothing else, which is all a tokenizer folds.
 *
 * `toLowerCase()` folds the whole of Unicode, and `<linK>` with a Kelvin sign for its last letter
 * comes out of that as `link` — an element no browser loads anything for, read here as one that
 * does. The names being compared are ASCII, and so is the folding.
 */
export function asciiLower(value: string): string {
  return value.replaceAll(/[A-Z]/gu, (character) => character.toLowerCase());
}

function isAsciiSpace(character: string | undefined): boolean {
  return character !== undefined && ASCII_SPACES.includes(character);
}
/** A tag name starts with an ASCII letter, and nothing else opens a tag at all. */
function isAsciiLetter(character: string | undefined): boolean {
  const code = character?.codePointAt(0);
  if (code === undefined) {
    return false;
  }
  return (code >= UPPER_START && code <= UPPER_END) || (code >= LOWER_START && code <= LOWER_END);
}
/**
 * Read a name that runs until one of `ends`, folded the way a tag or attribute name is folded.
 *
 * Whatever is not an ending character is part of the name — the tokenizer's rule, not a list of
 * the characters a name is usually written with. A markup framework writes `:href` or `@click`,
 * and a browser records the whole of that as one attribute: the element then has no `href` at all,
 * and reading the tail of one as a name would turn a link that loads nothing into a hint.
 */
function consumeName(
  raw: string,
  start: number,
  ends: ReadonlySet<string>,
): { name: string; next: number } | undefined {
  let index = start;
  while (index < raw.length && !ends.has(raw[index] ?? '')) {
    index += 1;
  }
  return index === start ? undefined : { name: asciiLower(raw.slice(start, index)), next: index };
}
function skipSpaces(raw: string, start: number): number {
  let index = start;
  while (index < raw.length && isAsciiSpace(raw[index])) {
    index += 1;
  }
  return index;
}
function readQuoted(raw: string, quote: string, start: number): ReadValue | undefined {
  const end = raw.indexOf(quote, start);
  return end === -1 ? undefined : { value: raw.slice(start, end), next: end + 1 };
}
function readUnquoted(raw: string, start: number): ReadValue {
  let index = start;
  while (index < raw.length && !isAsciiSpace(raw[index]) && raw[index] !== TAG_END) {
    index += 1;
  }
  return { value: raw.slice(start, index), next: index };
}
/** What follows an attribute's name: a value it was given, or nothing, and where that ends. */
function readAttribute(raw: string, from: number): ReadValue | undefined {
  const index = skipSpaces(raw, from);
  if (raw[index] !== EQUALS) {
    return { value: '', next: index };
  }
  return readAttributeValue(raw, skipSpaces(raw, index + 1));
}

function readAttributeValue(raw: string, start: number): ReadValue | undefined {
  const quote = raw[start];
  if (quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE) {
    return readQuoted(raw, quote, start + 1);
  }
  return readUnquoted(raw, start);
}
/**
 * An attribute's name, `=` and all.
 *
 * A name is not allowed to start with `=`, and a tokenizer reading one there keeps the character
 * rather than dropping it: `<link =href="/app.css">` has an attribute called `=href`, no `href` at
 * all, and loads nothing. Starting the name behind the `=` instead would read that as a link and
 * send a hint for a file the page never asks for.
 */
function consumeAttributeName(
  raw: string,
  start: number,
): { name: string; next: number } | undefined {
  if (raw[start] !== EQUALS) {
    return consumeName(raw, start, ENDS_AN_ATTRIBUTE_NAME);
  }
  const rest = consumeName(raw, start + 1, ENDS_AN_ATTRIBUTE_NAME);
  return { name: EQUALS + (rest?.name ?? ''), next: rest?.next ?? start + 1 };
}
/** The element a tag names, or `undefined` where no tag is opening. */
function consumeTagName(raw: string, start: number): { name: string; next: number } | undefined {
  return isAsciiLetter(raw[start]) ? consumeName(raw, start, ENDS_A_TAG_NAME) : undefined;
}
interface TagAttributes {
  readonly attributes: Map<string, string>;
  /** Just past the tag's `>`, or the end of the markup when the tag never closes. */
  readonly next: number;
  /**
   * Whether the tag's own `>` was there to be read.
   *
   * The scan stops at a fixed number of bytes, so the last tag in the window may be half of one —
   * with a `rel` and an `href` read and the `media` or `integrity` that would have excluded it
   * still to come. What was not read whole is not judged.
   */
  readonly closed: boolean;
  /** Whether a `/` closed the tag, which is what ends an element in foreign content. */
  readonly selfClosing: boolean;
}
/**
 * The attributes of the tag that starts at `from`, first value wins, boolean ones reading as the
 * empty string — and where the tag ends.
 *
 * Quote-aware, which is the whole point of reading a tag rather than searching for one: the `>` of
 * `<meta content="<link href='/x.css'>">` is inside a value, and the `<link` before it is text the
 * document never asked anyone to fetch.
 */
function readAttributes(raw: string, from: number): TagAttributes {
  const attributes = new Map<string, string>();
  let index = from;
  let slash = false;
  while (index < raw.length) {
    const before = index;
    index = skipSpaces(raw, index);
    if (index !== before) {
      // A `/` only closes a tag where the `>` comes next; whitespace leaves that state behind.
      slash = false;
    }
    if (index >= raw.length) {
      break;
    }
    if (raw[index] === TAG_END) {
      return { attributes, next: index + TAG_END.length, closed: true, selfClosing: slash };
    }
    const parsed = consumeAttributeName(raw, index);
    if (parsed === undefined) {
      // A `/` before the `>`, or anything else a name cannot start with.
      slash = raw[index] === SELF_CLOSING;
      index += 1;
      continue;
    }
    slash = false;
    const read = readAttribute(raw, parsed.next);
    if (read === undefined) {
      // An unterminated quote runs to the end of the markup, as it does for a parser.
      break;
    }
    index = read.next;
    if (!attributes.has(parsed.name)) {
      attributes.set(parsed.name, read.value);
    }
  }
  return { attributes, next: raw.length, closed: false, selfClosing: false };
}
/**
 * Where the markup resumes after a comment, or `-1` when nothing closes it.
 *
 * A comment has more ways to end than the one it is usually written with. `--!>` closes it, and so
 * does a `>` that arrives before any content at all — `<!-->` and `<!--->` are both comments that
 * are over as soon as they begin. Missing any of them is the dangerous direction: the walk would
 * step over markup a browser reads, and a `<body>` stepped over is a head that never ends.
 *
 * Both dashes of a close have to be the comment's own, which is why the search starts past the
 * opener rather than at it. `<!---!>` looks like it holds one — the `-` it opened with and the `-`
 * that follows spell `--!>` together — but a tokenizer reads that dash as the first of the data
 * and never closes the comment, so the rest of the document is inside it and the head is over.
 */
function endOfComment(html: string, from: number): number {
  // `<!-->` and `<!--->`, where the `>` comes before anything the comment could hold.
  const opening = html.startsWith(COMMENT_DASH, from) ? from + COMMENT_DASH.length : from;
  if (html.startsWith(TAG_END, opening)) {
    return opening + TAG_END.length;
  }
  const plain = html.indexOf(COMMENT_CLOSE, from);
  const bang = html.indexOf(COMMENT_CLOSE_BANG, from);
  if (plain === -1 && bang === -1) {
    return -1;
  }
  return plain !== -1 && (bang === -1 || plain < bang)
    ? plain + COMMENT_CLOSE.length
    : bang + COMMENT_CLOSE_BANG.length;
}
/**
 * The marks script data changes state on, in the order they are written: a comment's opening and
 * close, and `script` opening or ending a tag — the whole name, folded only where it is ASCII, as a
 * tokenizer folds it, so `<SCRIPT>` opens the double escape a browser opens for it.
 *
 * One search, carried on from each mark to the next, so a script is read once however many marks it
 * holds. Looking for every kind afresh at each mark would read the rest of the window once a mark —
 * quadratic, in a script of nested `<script` markers, which the window has room for thousands of.
 */
const SCRIPT_MARK = /<!--|-->|<\/?[Ss][Cc][Rr][Ii][Pp][Tt](?=[\t\n\f\r />])/u;
/**
 * Where a `<script>` ends, which is not always at the first `</script>` written in it.
 *
 * Script data has states a comment opens. Inside `<!--`, a nested `<script` puts the tokenizer
 * into its double-escaped state, and the `</script>` after that only takes it back out again — so
 * `<script><!--<script></script>` is a script still running, and what follows is still its text.
 *
 * `-->` ends both escapes rather than stepping down one. Read from the standard rather than from
 * the symmetry one would expect: §13.2.5.29, the
 * [script data double escaped dash dash state](https://html.spec.whatwg.org/multipage/parsing.html#script-data-double-escaped-dash-dash-state),
 * says of `>` "Switch to the script data state", the same words §13.2.5.22 uses for the
 * [singly escaped one](https://html.spec.whatwg.org/multipage/parsing.html#script-data-escaped-dash-dash-state).
 * So a `<script` written after one opens nothing, and the end tag after that is the element's.
 */
function endOfScript(html: string, from: number): number {
  let escaped = false;
  let doubleEscaped = false;
  const marks = new RegExp(SCRIPT_MARK, 'gu');
  marks.lastIndex = from;
  for (let mark = marks.exec(html); mark !== null; mark = marks.exec(html)) {
    const [written] = mark;
    if (written === COMMENT_OPEN) {
      escaped = true;
      // Its dashes are a close's first two as well: past them the tokenizer is where `--` leaves
      // it, so the `>` of `<!-->` or `<!--->` ends the escape it has just begun.
      marks.lastIndex = mark.index + COMMENT_OPEN.indexOf(COMMENT_DASH);
    } else if (written === COMMENT_CLOSE) {
      escaped = false;
      doubleEscaped = false;
    } else if (written[TAG_START.length] !== '/') {
      doubleEscaped = escaped;
    } else if (doubleEscaped) {
      doubleEscaped = false;
    } else {
      const end = readAttributes(html, marks.lastIndex);
      return end.closed ? end.next : -1;
    }
  }
  return -1;
}
/**
 * Where the markup resumes after `<name>`'s own end tag, or `-1` if it never does.
 *
 * An end tag is its name and nothing more: `</scripture>` is text a script is allowed to contain,
 * and reading it as the end of the script would hand the rest of that string to the walk as
 * markup — the likeliest place in a head to find a `<link>` written as text. A tag name is also
 * ASCII case-insensitive, which is what `consumeTagName` folds it to.
 */
function endOfRawText(html: string, name: string, from: number): number {
  if (name === SCRIPT_NAME) {
    return endOfScript(html, from);
  }
  if (name === PLAINTEXT_NAME) {
    // Nothing closes plaintext. The tokenizer stays in it to the last byte of the document, so
    // `</plaintext>` is text like everything else after it — including a `</template>`.
    return -1;
  }
  const close = `${TAG_START}/`;
  let at = from;
  while (at < html.length) {
    const start = html.indexOf(close, at);
    if (start === -1) {
      return -1;
    }
    at = start + close.length;
    const found = consumeTagName(html, at);
    if (found?.name !== name) {
      continue;
    }
    const end = readAttributes(html, found.next);
    return end.closed ? end.next : -1;
  }
  return -1;
}
/**
 * Whether the markup between two tags is anything but the whitespace a head may be laid out with.
 *
 * As written, not as a tokenizer would decode it: `&#32;` is a space to a browser and a head that
 * carries on, and text to this, which ends the walk there. That is the trade the rest of this
 * makes with a character reference — a `rel` or an `href` holding one is a link no hint is sent
 * for — and it falls the same way, towards a head that ends early rather than one that runs on
 * into a body. A head whose whitespace is written that way loses the hints below it, and a page
 * whose head is laid out with `&#32;` is not one anything generates.
 */
function holdsText(html: string, from: number, to: number): boolean {
  for (let at = from; at < to; at += 1) {
    if (!isAsciiSpace(html[at])) {
      return true;
    }
  }
  return false;
}
/** What one walk of a head collects, and what it is in the middle of while collecting it. */
export interface HeadScan {
  /** The `<link>` elements the head names, in the order it names them. */
  readonly links: Map<string, string>[];
  /** How many inert templates the walk is inside. Nothing written in one is loaded. */
  inert: number;
  /**
   * How many templates deep the walk was when it went into SVG or MathML, or `0` while it is in
   * neither: from there until that template closes, it may be in foreign content.
   */
  foreign: number;
  /** The first `<base href>`, which is the one a parser resolves the markup's URLs against. */
  base: string | undefined;
}
/** What the walk found at a `<`: a tag it read, or nothing it could read as one. */
interface OpenTag {
  readonly name: string;
  readonly closing: boolean;
  readonly attributes: Map<string, string>;
  readonly next: number;
  /** Whether the whole tag was inside the scan window; see `TagAttributes`. */
  readonly closed: boolean;
  /** Whether a `/` closed it, which is what ends an element in foreign content. */
  readonly selfClosing: boolean;
}
function readTag(html: string, start: number): OpenTag | undefined {
  const closing = html[start + TAG_START.length] === '/';
  const at = start + TAG_START.length + (closing ? 1 : 0);
  const name = consumeTagName(html, at);
  if (name === undefined) {
    return undefined;
  }
  const tag = readAttributes(html, name.next);
  return {
    name: name.name,
    closing,
    attributes: tag.attributes,
    next: tag.next,
    closed: tag.closed,
    selfClosing: tag.selfClosing,
  };
}
/**
 * Where the walk carries on from a `<` that opens no tag.
 *
 * `<!doctype html>`, `<?xml?>`, `</>`: not tags, but not text either — a parser reads each to its
 * `>` and keeps going. A `<` in front of anything else is the character it looks like, which is
 * character data, which closes a head.
 */
function stepOverDeclaration(html: string, start: number, scan: HeadScan): number {
  if (!MARKUP_DECLARATION.has(html[start + TAG_START.length] ?? '')) {
    return scan.inert > 0 ? start + TAG_START.length : -1;
  }
  if (asciiLower(html.slice(start, start + DOCTYPE_OPEN.length)) === DOCTYPE_OPEN) {
    return endOfDoctype(html, start);
  }
  if (scan.foreign > 0 && html.startsWith(CDATA_OPEN, start)) {
    return -1;
  }
  // Everything else a `<!` or `<?` opens is a bogus comment, which ends at the first `>` whatever
  // is in front of it.
  const ends = html.indexOf(TAG_END, start);
  return ends === -1 ? -1 : ends + TAG_END.length;
}
/**
 * Where a doctype ends, which is not always at its first `>`.
 *
 * A legacy doctype carries a quoted public or system identifier, and a `>` inside one of those is
 * part of the identifier: ending there would hand the rest of the doctype to the walk as markup,
 * and a doctype is a place a `<link>` can be written as text.
 *
 * Only one that names an identifier, though, and only for as many identifiers as it may name: one
 * after `SYSTEM`, two after `PUBLIC`. A quote anywhere else is an ordinary character of a doctype
 * the tokenizer has already given up on, which still ends at its first `>` — and reading it as an
 * identifier would step over that `>` and whatever followed, the `<body>` that ends the head
 * included.
 */
function endOfDoctype(html: string, start: number): number {
  const plain = html.indexOf(TAG_END, start);
  if (plain === -1) {
    return -1;
  }
  const from = start + DOCTYPE_OPEN.length;
  const named = DOCTYPE_IDENTIFIER.exec(asciiLower(html.slice(from, plain)));
  if (named === null) {
    return plain + TAG_END.length;
  }
  let at = from + named[0].length;
  const identifiers = named[0].endsWith(DOCTYPE_PUBLIC) ? PUBLIC_AND_SYSTEM : 1;
  for (let read = 0; read < identifiers; read += 1) {
    const ends = endOfIdentifier(html, at);
    if (ends === -1) {
      return -1;
    }
    at = ends;
  }
  const ends = html.indexOf(TAG_END, at);
  return ends === -1 ? -1 : ends + TAG_END.length;
}
/**
 * Where a quoted identifier ends, or where a doctype carries on without the one it could have had.
 *
 * A quote opens an identifier only where a tokenizer is looking for one: right after the keyword,
 * and again where a system identifier may follow a public one. Anything else in either place puts
 * it in the bogus state, where a quote is a character like another and the first `>` still ends
 * the declaration — so this hands back the position it was given and lets that `>` be found.
 * `-1` is an identifier nothing closes, which runs to the end of the document as it does for a
 * tokenizer.
 */
function endOfIdentifier(html: string, from: number): number {
  const at = skipSpaces(html, from);
  const quote = html[at];
  if (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE) {
    return at;
  }
  const ends = html.indexOf(quote, at + 1);
  return ends === -1 ? -1 : ends + 1;
}
/**
 * An end tag: where it leaves the walk.
 *
 * None takes it out of a foreign element: whether `</svg>` or `</math>` closes one is the stack's
 * to say (`FOREIGN_ROOTS`), and an exit taken where a parser takes none — a `</math>` inside an
 * `<svg>` — reads what follows as HTML that a browser still reads as SVG.
 */
function stepOverEndTag(tag: OpenTag, scan: HeadScan): number {
  return CLOSES_THE_HEAD.has(tag.name) && scan.inert === 0 ? -1 : tag.next;
}

/**
 * A template's tag, one deeper into inert markup or one back out.
 *
 * Its end tag pops everything opened inside it, so foreign content the walk went into there ends
 * with it.
 */
function stepOverTemplate(tag: OpenTag, scan: HeadScan): number {
  scan.inert = Math.max(scan.inert + (tag.closing ? -1 : 1), 0);
  if (scan.inert < scan.foreign) {
    scan.foreign = 0;
  }
  return tag.next;
}

/**
 * Note the depth the walk goes into foreign content at, the outermost if it nests.
 *
 * `<svg/>` opens nothing: a foreign element is the one place a `/` ends a tag on its own.
 */
function stepIntoForeign(tag: OpenTag, scan: HeadScan): number {
  if (!tag.selfClosing && scan.foreign === 0) {
    scan.foreign = scan.inert;
  }
  return tag.next;
}

/**
 * Whether this `<meta>` hands the document a policy, which is where the walk stops.
 *
 * A policy delivered in the markup applies to everything loaded after it is parsed, and a hint is
 * a fetch started before the browser has read a byte of the document — a `103` before the Worker
 * even runs. So a stylesheet written under `style-src 'none'` is one the page does not load and
 * this must not start. What was named *above* the meta is kept: the browser has those fetches in
 * flight before the policy exists, which is the same order a hint puts them in.
 *
 * Only the enforcing one. `content-security-policy-report-only` in a `<meta>` is ignored by a
 * parser outright, and an `http-equiv` this cannot read — one with a character reference in it —
 * is read as a policy it might be, for the same reason a `rel` with one names no link here.
 */
function deliversPolicy(tag: OpenTag): boolean {
  const equiv = tag.attributes.get(HTTP_EQUIV_ATTR) ?? '';
  const declared = asciiLower(equiv) === POLICY_EQUIV || equiv.includes('&');
  return declared && (tag.attributes.get(CONTENT_ATTR) ?? '') !== '';
}

/**
 * Whether this `<meta>` asks that the document's own requests say less than a hint's would.
 *
 * `<meta name="referrer" content="no-referrer">` governs what is fetched after it, and a fetch a
 * header starts is made before any of the document has been read — so the hint would carry the
 * URL the document asked to keep out of its requests. The walk ends there for the same reason it
 * ends at a policy: what is named above it is already in flight when the meta is parsed.
 *
 * Read as the markup form is read: one token rather than the header's list, with the spellings it
 * had before the header existed — `never` is `no-referrer`, and a document writing it asks for the
 * same silence. `content="unsafe-url, no-referrer"` is no policy at all there, and the document
 * keeps the one it had, so the walk carries on. A `content` this cannot read is read as the policy
 * it might be, as the `name` beside it is.
 */
function quietensTheReferrer(tag: OpenTag): boolean {
  const name = tag.attributes.get(NAME_ATTR) ?? '';
  if (asciiLower(name) !== REFERRER_NAME && !name.includes('&')) {
    return false;
  }
  const content = tag.attributes.get(CONTENT_ATTR) ?? '';
  return content.includes('&') || quietensASameOriginFetch(metaReferrerPolicy(content));
}
/**
 * Read the tag at `start`, note it if it is a `<link>`, and say where the walk carries on from.
 *
 * `-1` ends it: the head is over, or an element that swallows markup never closed.
 */
function stepOverTag(html: string, start: number, scan: HeadScan): number {
  const tag = readTag(html, start);
  if (tag === undefined) {
    return stepOverDeclaration(html, start, scan);
  }
  if (tag.name === TEMPLATE_NAME) {
    return stepOverTemplate(tag, scan);
  }
  if (tag.closing) {
    return stepOverEndTag(tag, scan);
  }
  // Before the raw text below it, not after: a `<textarea>` holds raw text and a head holds no
  // textarea, so the head is closed by it rather than the walk carrying on past its end tag.
  if (scan.inert === 0 && !BEFORE_THE_BODY.has(tag.name)) {
    return -1;
  }
  if (FOREIGN_ROOTS.has(tag.name)) {
    return stepIntoForeign(tag, scan);
  }
  if (OPAQUE_ELEMENTS.has(tag.name)) {
    // Text to HTML, and markup in SVG or MathML unless an integration point is above it, which the
    // walk cannot see: read either way, it may step over a template's end tag or read one in.
    return scan.foreign > 0 ? -1 : endOfRawText(html, tag.name, tag.next);
  }
  if (scan.inert > 0) {
    // A template holds markup a head could not: reading it is not being in the body.
    return tag.next;
  }
  if (tag.name === META_NAME && (deliversPolicy(tag) || quietensTheReferrer(tag))) {
    return -1;
  }
  if (tag.name === LINK_NAME && tag.closed) {
    scan.links.push(tag.attributes);
  }
  if (tag.name === BASE_NAME) {
    scan.base ??= tag.attributes.get(HREF_ATTR);
  }
  return tag.next;
}
/**
 * The `<link>` elements a head names, in the order it names them.
 *
 * One walk, left to right, reading what a parser would read: a tag's attributes are read
 * quote-aware, so a `<link>` written inside one is text; an element whose content is not markup is
 * stepped over whole, so a `<link>` written inside *that* is text as well; and a comment is
 * stepped over the same way. The walk stops where the head does: at `</head>`, or at the first
 * element a head cannot hold, which is what an omitted `</head>` is closed by.
 */
export function scanHead(shell: Uint8Array): HeadScan {
  const html = decodeUtf8(shell.subarray(0, Math.min(shell.byteLength, HEAD_SCAN_BYTES)));
  const scan: HeadScan = { links: [], inert: 0, foreign: 0, base: undefined };
  let at = 0;
  while (at < html.length) {
    const start = html.indexOf(TAG_START, at);
    if (start === -1) {
      break;
    }
    // Text closes a head the markup did not close itself, so a `<link>` written after a stray
    // word belongs to the body, whatever it names. Inside a template it is just text.
    if (scan.inert === 0 && holdsText(html, at, start)) {
      break;
    }
    const next = html.startsWith(COMMENT_OPEN, start)
      ? endOfComment(html, start + COMMENT_OPEN.length)
      : stepOverTag(html, start, scan);
    if (next === -1) {
      break;
    }
    at = next;
  }
  return scan;
}
