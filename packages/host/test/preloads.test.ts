import { MAX_PRELOAD_LINKS } from '@stayingupwind/core/manifest';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import {
  shellPreloadLinks,
  withoutAdvertised,
  withoutForbidden,
} from '../src/preloads/preloads.ts';

const FONT = '/_next/static/media/geist.woff2';
const STYLE = '/_next/static/chunks/app.css';

/** A shell whose head is `head` and whose body is long enough not to be mistaken for one. */
function shell(head: string, body = '<p>static</p>'): Uint8Array {
  return encodeUtf8(`<!doctype html><html><head>${head}</head><body>${body}`);
}

describe('withoutAdvertised', () => {
  /**
   * The hosted path scans a shell before it knows what the route's own headers say, so the
   * deduplication the proof does at the same moment has to be applied afterwards there.
   */
  it('drops what the header already preloads as the same thing, and keeps the rest', () => {
    const style = `<${STYLE}>; rel=preload; as=style`;
    const font = `<${FONT}>; rel=preload; as=font; crossorigin=""`;
    const sameFont = `<${FONT}>; rel=preload; as="font"; crossorigin=""`;

    expect(withoutAdvertised([style, font], sameFont)).toStrictEqual([style]);
    // Without `crossorigin` it is a different request, and one the markup's own cannot use.
    expect(withoutAdvertised([font], `<${FONT}>; rel=preload; as="font"`)).toStrictEqual([font]);
    expect(withoutAdvertised([style, font], `<${STYLE}>; rel=canonical`)).toStrictEqual([
      style,
      font,
    ]);
    expect(withoutAdvertised([style], undefined)).toStrictEqual([style]);
  });
});

describe('withoutForbidden', () => {
  const style = `</app.css>; rel=preload; as=style`;
  const font = `<${FONT}>; rel=preload; as=font; crossorigin="anonymous"`;

  /**
   * A policy reaches a `103` too late to be obeyed: Cloudflare replays the `Link` values alone,
   * before the Worker runs, so a hint for what the policy forbids is a request the document is not
   * allowed to make and cannot stop. Judged per destination, because a policy that has nothing to
   * say about stylesheets may still have something to say about fonts.
   */
  it.each([
    ["style-src 'none'", [font]],
    ["default-src 'none'", []],
    ["font-src 'none'", [style]],
    // A nonce names no URL, and a hint carries none: the link the markup nonces is not promoted
    // either, so what this drops is a hint that was never going to be fetched.
    ["style-src 'nonce-abc123'", [font]],
    ["style-src 'unsafe-inline'", [font]],
    // Two policies in one header are enforced one by one, so the strictest of them decides.
    ["style-src 'self', default-src 'none'", []],
    // A host is a host this cannot check: the document is served under whichever name the project
    // has, which is not known where a route's headers are read. Named `'self'` it would be kept.
    ['style-src https://cdn.example', [font]],
  ])('drops what %s forbids', (policy, kept) => {
    expect(withoutForbidden([style, font], { 'content-security-policy': policy })).toStrictEqual(
      kept,
    );
  });

  /** A directive that names somewhere to fetch from forbids nothing this sends. */
  it.each([
    "style-src 'self'; font-src 'self'",
    'default-src https:',
    // "We always allow a secure upgrade from an explicitly insecure expression": `http:` is read
    // as `http: https:`, and what a host serves is https.
    'default-src http:',
    "script-src 'none'",
    "default-src 'self'; style-src-elem 'self'",
  ])('keeps them under %s', (policy) => {
    expect(withoutForbidden([style, font], { 'content-security-policy': policy })).toStrictEqual([
      style,
      font,
    ]);
  });

  /**
   * A fetch a header starts carries the document's full URL, because the policy that would have
   * quietened it has not reached the browser yet. Under these three the document's own request
   * carries less than that, so a hint would put in the `Referer` what the document kept out of it.
   */
  it.each([
    'no-referrer',
    'origin',
    'strict-origin',
    'unsafe-url, no-referrer',
    // A browser skips what it does not recognise, so a word behind the policy does not clear it.
    'no-referrer, nonsense-policy',
  ])('sends nothing under a referrer policy of %s', (policy) => {
    expect(withoutForbidden([style, font], { 'referrer-policy': policy })).toStrictEqual([]);
  });

  /**
   * The rest leave a same-origin fetch sending the document's URL, which is what the hint's own
   * fetch sends. The value in force is the last one a browser recognises, whatever follows it.
   */
  it.each([
    'strict-origin-when-cross-origin',
    'same-origin',
    'unsafe-url',
    'no-referrer, same-origin',
  ])('keeps them under a referrer policy of %s', (policy) => {
    expect(withoutForbidden([style, font], { 'referrer-policy': policy })).toStrictEqual([
      style,
      font,
    ]);
  });

  it('keeps them for a route whose headers say nothing about either', () => {
    expect(withoutForbidden([style, font], { 'content-type': 'text/html' })).toStrictEqual([
      style,
      font,
    ]);
  });
});

describe('shellPreloadLinks', () => {
  it('promotes the stylesheets and fonts an App Router head names', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}" data-precedence="next"/>` +
        `<link rel="preload" as="font" href="${FONT}" crossorigin="" type="font/woff2"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
      `<${FONT}>; rel=preload; as=font; crossorigin="anonymous"; type="font/woff2"`,
    ]);
  });

  /**
   * Both are named in a Next.js head, and both would contend for bandwidth with the stylesheet
   * that actually blocks the paint. A preload the page did not ask the browser to race is worse
   * than no preload.
   */
  it('leaves images and scripts where the markup put them', () => {
    const bytes = shell(
      `<link rel="preload" as="image" href="/hero.png"/>` +
        `<link rel="preload" as="script" fetchPriority="low" href="/chunk.js"/>` +
        `<link rel="canonical" href="/canonical"/>` +
        `<link rel="manifest" href="/manifest.webmanifest"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([]);
  });

  /** A third-party stylesheet is the application's to discover, and `//host` is another origin. */
  it('promotes nothing that is not a path on this origin', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="https://cdn.example/app.css"/>` +
        `<link rel="stylesheet" href="//cdn.example/other.css"/>` +
        `<link rel="stylesheet" href="app.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([]);
  });

  it('reads attributes however the markup quotes them', () => {
    // Separated and listed the way HTML allows rather than the way they are usually written: a
    // form feed between attributes, and a rel list a newline runs through.
    const bytes = shell(
      `<link href=${STYLE}\frel="stylesheet\nnoreferrer">` +
        `<link rel='preload' as='font' href='${FONT}' crossorigin>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
      `<${FONT}>; rel=preload; as=font; crossorigin="anonymous"`,
    ]);
  });

  /**
   * `media="print"` is how a page loads a sheet without blocking the paint, an `alternate` is one
   * the reader has to pick, and a `disabled` one is never applied. Promoting any of them would
   * have the browser race what the page kept out of the way against what it blocks on.
   */
  it('promotes only the stylesheets the page actually blocks on', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="/print.css" media="print"/>` +
        `<link rel="alternate stylesheet" href="/high-contrast.css"/>` +
        `<link rel="stylesheet" href="/off.css" disabled/>` +
        `<link rel="stylesheet" href="${STYLE}" media="all"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /** No parser reads these as markup, so a link written in one is text and names no resource. */
  it('reads no link out of a script, a title or a template', () => {
    const bytes = shell(
      `<script>const t = '<link rel="stylesheet" href="/in-a-script.css">';</script>` +
        `<title>About <link rel="stylesheet" href="/in-a-title.css"></title>` +
        `<template><link rel="stylesheet" href="/in-a-template.css"></template>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * An element a script only writes the opening of is text like the rest of it. Pairing that
   * opening with the real end tag below would swallow everything between the two, and what the
   * head asks the browser for is in there.
   */
  it('pairs no end tag with an element a script only mentions', () => {
    const bytes = shell(
      `<script>const t = '<template>';</script>` +
        `<link rel="stylesheet" href="${STYLE}"/>` +
        `<template>a row</template>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A preload is the request the page goes on to make only if it is made the same way, and
   * `crossorigin` is what decides that: a sheet fetched in CORS mode behind a hint that does not
   * say so is two downloads of one file, the first of them in front of the paint.
   */
  it('carries the crossorigin a stylesheet is fetched under', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}" crossorigin="anonymous"/>` +
        `<link rel="preload" as="style" href="/late.css" crossorigin/>` +
        `<link rel="preload" as="style" href="/account.css" crossorigin="USE-Credentials"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style; crossorigin="anonymous"`,
      // A boolean attribute leaves the empty string behind, which is the anonymous state written
      // the shortest way there is — and the state is what a header has to name.
      '</late.css>; rel=preload; as=style; crossorigin="anonymous"',
      // An enumerated attribute is matched without case, so this is the second state and not the
      // nonsense the casing makes of it.
      '</account.css>; rel=preload; as=style; crossorigin="use-credentials"',
    ]);
  });

  /**
   * A relation is a list of tokens separated by the whitespace HTML separates by, and a no-break
   * space is not one of those: it is a character of the token, so the relation is a word no
   * browser knows and the sheet is never loaded. The same goes for the media a sheet is
   * conditional on, which a CSS parser reads with the same whitespace around it and no other.
   */
  it('reads a token nothing but html whitespace surrounds', () => {
    const rel = shell(`<link rel="\u{A0}stylesheet\u{A0}" href="/unused.css"/>`);
    const media = shell(`<link rel="stylesheet" media="\u{A0}all\u{A0}" href="/unused.css"/>`);

    expect(shellPreloadLinks(rel, undefined)).toStrictEqual([]);
    expect(shellPreloadLinks(media, undefined)).toStrictEqual([]);
  });

  /**
   * A browser skips a format it cannot use, and the markup is where it is told which one this is.
   * A hint that drops the type would have it fetch what the markup had excused it from.
   */
  it('carries the type a link declares', () => {
    const bytes = shell(
      `<link rel="preload" as="style" type="text/css" href="${STYLE}"/>` +
        `<link rel="stylesheet" type="text/less" href="/theme.less"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style; type="text/css"`,
      '</theme.less>; rel=preload; as=style; type="text/less"',
    ]);
  });

  /**
   * A tokenizer keeps the markup inside an attribute value as the text it is. Searching the head
   * for `<link` instead would fetch what a `content=` only quotes.
   */
  it('reads no link out of another tag’s attribute value', () => {
    const bytes = shell(
      `<meta name="description" content="<link rel='stylesheet' href='/quoted.css'>"/>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A script may contain `</scripture>` and go on running: an end tag is the name and nothing
   * more. Ending the script there would hand the rest of its own text to the scan as markup.
   */
  it('ends a script at its own end tag, not at a longer name', () => {
    const bytes = shell(
      `<script>const t = '</scripture><link rel="stylesheet" href="/in-a-script.css">';</script>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * The head ends where the markup says it does, not where a script quotes it: cutting at the
   * quoted one would leave the head's own stylesheets on the far side of the cut.
   */
  it('ends the head at its own end tag, not at one a script quotes', () => {
    const bytes = shell(
      `<script>const t = '</head>';</script><link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A policy the markup delivers applies to everything loaded after it is parsed, and a hint is a
   * fetch started before the browser has the document at all — a `103` starts it before the Worker
   * runs. So the stylesheet under one is not promoted, while the one named above it is: those
   * fetches are already in flight when the policy arrives, which is the order a hint puts them in.
   */
  it.each([
    'Content-Security-Policy',
    // A tokenizer decodes this before it reads the name, so it is that name; an `http-equiv` this
    // cannot read is read as the policy it might be, as a `rel` with one names no link here.
    'content-security-polic&#121;',
  ])('stops at a policy the head delivers itself as %s', (equiv) => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}"/>` +
        `<meta http-equiv="${equiv}" content="style-src 'none'">` +
        `<link rel="stylesheet" href="/under-a-policy.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A `<meta name="referrer">` governs what the document fetches after it, and a fetch a header
   * starts carries the URL the document asked to keep out of its requests. The walk ends there
   * as it ends at a policy, and what was named above it is kept: those fetches are in flight
   * before the meta is parsed.
   */
  it.each(['no-referrer', 'origin', 'strict-origin', 'never'])(
    'stops at a referrer of %s the head asks for',
    (policy) => {
      const bytes = shell(
        `<link rel="stylesheet" href="${STYLE}"/>` +
          `<meta name="referrer" content="${policy}">` +
          `<link rel="stylesheet" href="/under-a-policy.css"/>`,
      );

      expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
        `<${STYLE}>; rel=preload; as=style`,
      ]);
    },
  );

  /** The rest leave a same-origin fetch saying what a hint's own fetch says. */
  it.each([
    '<meta name="referrer" content="strict-origin-when-cross-origin">',
    '<meta name="referrer" content="same-origin">',
    '<meta name="referrer" content="">',
    '<meta name="description" content="no-referrer">',
    // One token, not the header's list: a `content` of two names is no policy at all there, and
    // the document keeps the one it had.
    '<meta name="referrer" content="unsafe-url, no-referrer">',
    // A legacy spelling of a policy that asks for no less than a hint's own fetch sends.
    '<meta name="referrer" content="always">',
  ])('carries on past %s', (meta) => {
    const bytes = shell(`${meta}<link rel="stylesheet" href="${STYLE}"/>`);

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * Only the one a browser enforces. A `<meta>` naming another header carries no policy, and a
   * report-only one is ignored by a parser outright — a head that ended at either would lose the
   * hints below it for nothing.
   */
  it.each([
    '<meta http-equiv="x-ua-compatible" content="IE=edge">',
    `<meta http-equiv="content-security-policy-report-only" content="style-src 'none'">`,
    '<meta http-equiv="Content-Security-Policy" content="">',
    `<template><meta http-equiv="Content-Security-Policy" content="style-src 'none'"></template>`,
  ])('carries on past %s', (meta) => {
    const bytes = shell(`${meta}<link rel="stylesheet" href="${STYLE}"/>`);

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A head is closed by the first thing it cannot hold, written or not. Without that, a document
   * omitting `</head>` would have its body read as head and its late links raced against the ones
   * that block the paint.
   */
  it('stops at the first element a head cannot hold', () => {
    const bytes = encodeUtf8(
      `<!doctype html><html><head><link rel="stylesheet" href="${STYLE}"/>` +
        `<p>no head holds this</p><link rel="stylesheet" href="/in-the-body.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A template holds markup, not raw text: a parser reads it into a fragment nothing loads from,
   * and an end tag one of its own attributes quotes ends nothing. Reading it as raw text would
   * stop at that quote and hand the inert markup after it to the walk.
   */
  it('reads a template as the inert markup it is', () => {
    const bytes = shell(
      `<template><div data-note="</template>">` +
        `<link rel="stylesheet" href="/inactive.css"></div></template>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A path under a `<base>` on another host is a file on that host, while the same path on a
   * `Link` header is a file on the one that answered: a header resolves against the request, and
   * the document's base never reaches it.
   */
  it('promotes nothing from a head that moves its own origin', () => {
    const moved = shell(
      `<base href="https://cdn.example/"/><link rel="stylesheet" href="${STYLE}"/>`,
    );
    // A tokenizer resolves the reference before the URL is parsed, so this is that host too.
    const encoded = shell(
      `<base href="https&#58;//cdn.example/"/><link rel="stylesheet" href="${STYLE}"/>`,
    );
    // A scheme written through the whitespace a URL parser drops is still a scheme.
    const spaced = shell(
      `<base href="ht tps://cdn.example/"/><link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(moved, undefined)).toStrictEqual([]);
    expect(shellPreloadLinks(encoded, undefined)).toStrictEqual([]);
    expect(shellPreloadLinks(spaced, undefined)).toStrictEqual([]);
  });

  /**
   * A base moves only what is resolved after it. A parser fetched the stylesheet above it against
   * the document's own URL, before there was a base, and a link already fetched is not fetched
   * again when one arrives: that is the request a header makes. A `<base>` with no `href` is no
   * base at all, and moves nothing.
   */
  it('promotes what a head names before a base that moves its origin', () => {
    const bytes = shell(
      `<base target="_top"/><link rel="stylesheet" href="${STYLE}"/>` +
        `<base href="https://cdn.example/"/><link rel="stylesheet" href="/after-the-base.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A URL parser strips the C0 controls off both ends of what it is given before it parses
   * anything, so a host written behind one is still a host. Reading the control as the first
   * character of a path would make that base look like one that moves nothing.
   */
  it('promotes nothing from a base whose host hides behind a control character', () => {
    const bytes = shell(
      `<base href="\u{1}//cdn.example/"/><link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([]);
  });

  /**
   * A base that only moves the path moves no origin, and the paths this promotes are absolute
   * ones a base path does not touch. Those heads keep their hints.
   */
  it.each(['/app/', './', '../assets/', 'assets/'])(
    'keeps them under a base of %s, which changes no origin',
    (base) => {
      const bytes = shell(`<base href="${base}"/><link rel="stylesheet" href="${STYLE}"/>`);

      expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
        `<${STYLE}>; rel=preload; as=style`,
      ]);
    },
  );

  /**
   * The other side of that rule: the "in head" insertion mode has a rule for these, so a head
   * keeps them and the walk carries on to the stylesheet written behind one. `noframes` holds raw
   * text, and the other two are void elements a parser inserts and pops.
   */
  it.each(['<basefont/>', '<bgsound/>', '<noframes>frames are off</noframes>'])(
    'carries on past %s, which a head is allowed to hold',
    (legacy) => {
      const bytes = shell(`${legacy}<link rel="stylesheet" href="${STYLE}"/>`);

      expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
        `<${STYLE}>; rel=preload; as=style`,
      ]);
    },
  );

  /**
   * A head holds no textarea, so one closes it — before its own raw text is stepped over, or the
   * walk would come out the far side of an element that ended the head on the way in.
   */
  it('stops at an element a head cannot hold even when it holds raw text', () => {
    const bytes = encodeUtf8(
      `<!doctype html><html><head><link rel="stylesheet" href="${STYLE}"/>` +
        `<textarea></textarea><link rel="stylesheet" href="/in-the-body.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A browser records `:href` as one attribute, so the element has no `href` and loads nothing.
   * Reading the tail of a name as a name of its own would turn that into a hint.
   */
  it('reads an attribute name the way the tokenizer ends it', () => {
    const bytes = shell(
      `<link :href="/unused.css" rel="stylesheet">` +
        `<link @rel="stylesheet" href="/no-rel.css">` +
        `<link rel="stylesheet" href="${STYLE}">`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * An opening tag's attributes are the tag's, not its content: the end tag a `data-` attribute
   * quotes ends nothing, and the script it appears to close is still running.
   */
  it('does not end a script at an end tag its own attribute quotes', () => {
    const bytes = shell(
      `<script data-note="</script>">const t = '<link rel=stylesheet href=/in-a-script.css>';` +
        `</script><link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A digest is part of what a browser matches a preload against, and the markup may write a list
   * of them. A hint that cannot reproduce the request is a download the page cannot use.
   */
  it('leaves a link the markup asks to be checked against a digest', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="/signed.css" integrity="sha384-abc123"/>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A `>` inside a quoted identifier ends the doctype, as it ends every other state a doctype has:
   * the tokenizer calls it abrupt and emits the declaration there. So the `<script>` the identifier
   * seemed to hold opens a script, the link behind it is that script's text, and the stylesheet
   * after the script is the head's.
   */
  it('ends a doctype at a `>` its identifier seems to quote', () => {
    const bytes = encodeUtf8(
      `<!DOCTYPE html PUBLIC "-//x><script>"><link rel="stylesheet" href="/in-a-script.css">` +
        `</script><link rel="stylesheet" href="${STYLE}"/></head><body><p>x</p>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * And what follows that `>` is markup from its first byte: here a stylesheet of the head's own,
   * and then text, which closes the head and leaves the stylesheet after it to the body.
   */
  it('reads the markup after a doctype a quoted `>` ended', () => {
    const bytes = encodeUtf8(
      `<!doctype html SYSTEM "x><link rel='stylesheet' href='/after-the-doctype.css'>">` +
        `<html><head><link rel="stylesheet" href="${STYLE}"/></head><body><p>x</p>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      '</after-the-doctype.css>; rel=preload; as=style',
    ]);
  });

  /**
   * Script data has states a comment opens: inside `<!--`, a nested `<script` puts the tokenizer
   * into its double-escaped state, and the `</script>` after that only takes it back out. The
   * script is still running, and what follows is still its text.
   */
  it('keeps reading a script whose end tag only leaves its double-escaped state', () => {
    const bytes = shell(
      `<script><!--<script></script><link rel="stylesheet" href="/in-a-script.css"></script>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * In script data, `<!--` leaves the tokenizer where its two dashes lead, so the `>` of `<!-->` or
   * `<!--->` ends the escape it began. The `<script` after it opens nothing, the end tag after that
   * is the element's own, and the template after the script holds the link.
   */
  it.each(['<!-->', '<!--->'])('ends the escape %s closes as it opens', (opener) => {
    const bytes = shell(
      `<script>${opener}<script></script><template></script>` +
        `<link rel="stylesheet" href="/unused.css"></template>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A script is read once, whatever it holds: thousands of nested `<script` markers, and a run of
   * tags whose names never end, cost a pass over the window rather than one a mark.
   */
  it('reads a script of nested markers in one pass', () => {
    const markers = `<!--${'<script>'.repeat(100)}${'a<'.repeat(14_800)}</script>`;
    const bytes = shell(`<script>${markers}</script><link rel="stylesheet" href="${STYLE}"/>`);
    const started = performance.now();

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  /**
   * Outside SVG or MathML those characters open a bogus comment, which ends at the first `>`.
   * Reading them as a section steps over the `<body>` after it, and a head that never ends reads
   * what a browser put in the body — here, inside a comment — as its own.
   */
  it('reads a CDATA outside foreign content as the bogus comment it is', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}"/>` +
        `<![CDATA[><body><!-- ]]><link rel="stylesheet" href="/unused.css"> -->`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * Inside one, the walk ends rather than read past it either way: a section runs to `]]>` and a
   * bogus comment to the first `>`, so the `</template>` quoted in it closes nothing under one
   * reading and everything under the other. Whichever a browser is doing, the link beside it is
   * not one the head named.
   */
  it('ends the walk at a CDATA written in foreign content', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}"/>` +
        `<template><svg><![CDATA[></template>` +
        `<link rel="stylesheet" href="/unused.css">]]></svg></template>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * Which of the two it is depends on the element the tokenizer is under, not on the one it is
   * inside: `<foreignObject>` is an integration point, so the `<div>` under it is an HTML element
   * and the declaration is a bogus comment a browser ends at the first `>` — closing the template
   * and leaving the link in a comment of the body. Reading it as a section instead would step to
   * the `]]>` inside that comment and come back out into markup nobody wrote for a head.
   */
  it('ends the walk at one written under an integration point too', () => {
    const bytes = encodeUtf8(
      `<!doctype html><html><head><link rel="stylesheet" href="${STYLE}"/>` +
        `<template><svg><foreignObject><div><![CDATA[></template>` +
        `<body><!-- ]]></svg></template><link rel="stylesheet" href="/unused.css"> -->`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A `</math>` leaves no `<svg>`, nor a `</svg>` a `<math>`: a parser stays in the foreign element,
   * where the `<![CDATA[` after it opens a section and the `</template>` and the link inside it are
   * text. Taken for an exit, the end tag would have the declaration read as a bogus comment ending
   * at its first `>`, the template closed behind it, and the link promoted.
   */
  it.each([
    ['svg', 'math'],
    ['math', 'svg'],
  ])('stays in an <%s> through a </%s>', (root, other) => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}"/><template><${root}></${other}><![CDATA[>` +
        `</template><link rel="stylesheet" href="/unused.css">]]></${root}></template>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * What counts templates counts nothing else. The foreign content one held ends with it, so the
   * `</svg>` met in the next template takes nothing from that count: the link inside it stays
   * inert, and the head carries on after it.
   */
  it('counts templates apart from the foreign content they hold', () => {
    const bytes = shell(
      `<template><svg></template></template><template></svg>` +
        `<link rel="stylesheet" href="/unused.css"></template>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * And it does end with it: the template's end tag pops what was opened inside, the `<svg>` left
   * open included, and the link after it is the head's.
   */
  it('comes back to the head when the template around foreign content closes', () => {
    const bytes = shell(
      `<template><svg><path d="M0 0"></template><link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * In SVG a `<title>` holds markup, and is an integration point besides, so a `<template>` in it
   * is an HTML template that the walk would step over as title text. A `<style>` holds markup too,
   * and a comment in it may quote the end tag. Which reading holds is the stack's to say, so the
   * walk ends at either rather than read past a template's end, or into one.
   */
  it.each([
    '<svg><title><template></title></svg></template><link rel="stylesheet" href="/unused.css">',
    '<svg><style><!--</style></template><link rel="stylesheet" href="/unused.css">--></style>',
  ])('ends the walk at an element HTML reads as text, in foreign content: %s', (inside) => {
    const bytes = shell(`<link rel="stylesheet" href="${STYLE}"/><template>${inside}</template>`);

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A tokenizer folds the script markers too: `<SCRIPT>` inside the comment opens the same double
   * escape its lowercase spelling does, and the `</script>` after it closes nothing.
   */
  it('opens a script double escape however the nested tag is spelled', () => {
    const bytes = shell(
      `<script><!--<SCRIPT></script><link rel="stylesheet" href="/in-a-script.css"></script>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * The same from the double-escaped state, which is the one a nested `<script` opens. §13.2.5.29
   * of the standard gives `>` there the same words §13.2.5.22 gives it in the singly escaped one —
   * "Switch to the script data state" — so the end tag after `-->` really does close the element,
   * and the markup after it is the head's.
   */
  it('leaves a double escape on the comment that closes, not on the tag after it', () => {
    const bytes = shell(
      `<script><!--<script>--></script><link rel="stylesheet" href="${STYLE}"/></script>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * `-->` leaves the escape for plain script data, from either escaped state: both dash-dash
   * states switch to script data on `>`. So the `<script` after one opens nothing, and the
   * `</script>` after that is the end of the element rather than the end of an escape.
   */
  it('ends the escape a comment opened, and the script at the next end tag', () => {
    const bytes = shell(
      `<script><!-- --><script></script><link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * `--!>` ends a comment, but not an escape: in both dash-dash states its `!` goes back to the
   * escape. So after `<!--<script>--!>` the script is still double-escaped, the `</script>` after
   * that only takes it back out, and the script runs on to the next one.
   */
  it('leaves a script escape as it was at a --!>', () => {
    const bytes = shell(
      `<script><!--<script>--!></script><link rel="stylesheet" href="/in-a-script.css"></script>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * Nothing closes plaintext: the tokenizer stays in it to the last byte, so the `</plaintext>`
   * and the `</template>` after it are text, and so is everything past them.
   */
  it('reads nothing at all after a plaintext', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}"/>` +
        `<template><plaintext></plaintext></template>` +
        `<link rel="stylesheet" href="/unused.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A `/` only closes a tag where the `>` comes next: `<svg/ >` opens an element, and what it
   * holds is read as the foreign content it is — where a `<![CDATA[` is a declaration the walk
   * ends at rather than the bogus comment it would be outside one, read to its first `>` and out
   * the far side of the template.
   */
  it('opens an element a slash and a space did not close', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}"/>` +
        `<template><svg/ ><![CDATA[></template>` +
        `<link rel="stylesheet" href="/unused.css">`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A tokenizer decodes the references in an attribute before it reads the value, and the second
   * state is spelled with a character one can hide: `use&#45;credentials` is the credentialed mode
   * to a browser. A hint naming the anonymous one is a request the markup's own cannot use, so a
   * `crossorigin` carrying a reference this does not read is a link it sends nothing for.
   */
  it('promotes nothing from a crossorigin whose value hides behind a reference', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}" crossorigin="use&#45;credentials">`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([]);
  });

  /**
   * Only the two states a CORS settings attribute has are ever written into a header, so a value
   * written to break out of the quotes around it arrives as the state a browser reads it as.
   */
  it('names the state a crossorigin nobody could quote still asks for', () => {
    const bytes = shell(
      `<link rel=preload as=font href="${FONT}" crossorigin='"; rel=preconnect'>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${FONT}>; rel=preload; as=font; crossorigin="anonymous"`,
    ]);
  });

  /**
   * A key is joined on a character no attribute can hold, so no value written in one is read as
   * the absence of it — a `type` of `-` is a request of its own, whatever little sense it makes,
   * and the same font without one is a second.
   */
  it('tells an attribute from one that was never written', () => {
    const bytes = shell(
      `<link rel="preload" as="font" href="${FONT}" crossorigin type="-">` +
        `<link rel="preload" as="font" href="${FONT}" crossorigin>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${FONT}>; rel=preload; as=font; crossorigin="anonymous"; type="-"`,
      `<${FONT}>; rel=preload; as=font; crossorigin="anonymous"`,
    ]);
  });

  /**
   * A fragment never leaves the browser: `#one` and `#two` of a file are one request, which takes
   * one of the values a header carries, and one the header already sends stands in for both.
   */
  it('reads a file named with two fragments as one request', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}#one"/><link rel="stylesheet" href="${STYLE}#two"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}#one>; rel=preload; as=style`,
    ]);
    expect(shellPreloadLinks(bytes, `<${STYLE}>; rel=preload; as=style`)).toStrictEqual([]);
  });

  /**
   * A browser reads a media type's essence without case: `TEXT/CSS` is the `text/css` request, one
   * of the values a header carries for both, and one the header already sends stands in for it.
   */
  it('reads a type written in another case as the same', () => {
    const bytes = shell(
      `<link rel="stylesheet" type="TEXT/CSS" href="${STYLE}"/>` +
        `<link rel="stylesheet" type="text/css" href="${STYLE}"/>`,
    );
    const advertised = `<${STYLE}>; rel=preload; as=style; type="text/css"`;

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style; type="TEXT/CSS"`,
    ]);
    expect(shellPreloadLinks(bytes, advertised)).toStrictEqual([]);
  });

  /**
   * A quoted parameter may hold anything — a comma, a semicolon, another `<…>`. Reading one as a
   * second link records a preload nobody sent, and gives way to it.
   */
  it.each([
    [
      'holding one',
      `</already.css>; rel=preload; as=style; title="<${STYLE}>; rel=preload; as=style"`,
    ],
    [
      'holding one past a comma',
      `</already.css>; rel=preload; as=style; title="a, <${STYLE}>; rel=preload; as=style; x="`,
    ],
    // No `as` of its own: the one in the quotes belongs to the title, and a header that preloads
    // this file as nothing in particular is not the stylesheet request the page waits on.
    ['holding a parameter it does not have', `<${STYLE}>; rel=preload; title="x; as=style; y="`],
  ])('reads nothing out of a quoted parameter %s', (_case, advertised) => {
    const bytes = shell(`<link rel="stylesheet" href="${STYLE}"/>`);

    expect(shellPreloadLinks(bytes, advertised)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A stray `</svg>` closes nothing, for a parser or for this: taking it for an exit would step
   * out of the template it was written inside, and read what follows as markup a browser does not.
   */
  it('stays inside a template through an end tag that opened nothing', () => {
    const bytes = shell(
      `<template></svg><link rel="stylesheet" href="/unused.css"></template>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A quote outside a public or system identifier is an ordinary character of a malformed
   * doctype, which still ends at its first `>`. Reading it as an identifier steps over that `>`
   * and the `<body>` behind it.
   *
   * Each of these is a doctype a tokenizer takes to its bogus state: a bare quote, a name that
   * only starts with one of the words, a name that is one of them, one written past the name,
   * and one the spec looks for a quote after and does not find.
   */
  it.each(['"', 'systemfoo "', 'public "', 'html bogus public "', 'html public x "'])(
    'ends a doctype of `%s` at its first angle bracket',
    (declared) => {
      const bytes = encodeUtf8(
        `<!doctype ${declared}><html><head><link rel="stylesheet" href="${STYLE}"/>` +
          `<body><!-- "><link rel="stylesheet" href="/unused.css"> -->`,
      );

      expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
        `<${STYLE}>; rel=preload; as=style`,
      ]);
    },
  );

  /**
   * The quote that opens a system identifier needs no whitespace in front of it: the tokenizer
   * takes a `"` there as the opener and calls the missing whitespace a parse error. The `>` after
   * it still ends the doctype, as an abrupt end of that identifier, so the `<body>` behind it is
   * the body's, and the stylesheet sits in one of its comments.
   */
  it('ends a doctype at a `>` in a system identifier no whitespace set apart', () => {
    const bytes = encodeUtf8(
      `<!doctype html PUBLIC "id""><body><!-- "><link rel="stylesheet" href="/unused.css"/> -->`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([]);
  });

  /**
   * Past the identifiers a doctype may name, one after `SYSTEM` and two after `PUBLIC`, a word puts
   * the tokenizer in its bogus state, where a quote is a character and the first `>` still ends the
   * doctype, as it ends every other state.
   */
  it.each(['html public "id" bogus "', 'html system "id" "'])(
    'reads no identifier past the ones a doctype of `%s` may name',
    (declared) => {
      const bytes = encodeUtf8(
        `<!doctype ${declared}><html><head><link rel="stylesheet" href="${STYLE}"/>` +
          `<body><!-- "><link rel="stylesheet" href="/unused.css"> -->`,
      );

      expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
        `<${STYLE}>; rel=preload; as=style`,
      ]);
    },
  );

  /**
   * A name is not allowed to start with `=`, and a tokenizer keeps the character rather than
   * dropping it: the element has an `=href` and no `href`, so a browser loads nothing from it.
   */
  it('reads an attribute a stray equals sign renamed as the one it is', () => {
    const bytes = shell(
      `<link =href="/unused.css" rel="stylesheet"><link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A `</math>` closes no `<svg>`, and a parser with neither open ignores it. Unwinding the
   * foreign element on it would be wrong, but what keeps the link out of the hints is the
   * template around it: the walk promotes nothing while it is inside one, whatever the counting
   * of foreign elements inside it did.
   */
  it('promotes nothing after a foreign end tag that closed nothing', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}"/>` +
        `<template><svg></math><link rel="stylesheet" href="/unused.css">`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A template holds markup, so what is inside it is walked — but `<xmp>` switches the tokenizer
   * to raw text even there, and the `</template>` it quotes closes nothing.
   */
  it('reads no link out of raw text a template holds', () => {
    const bytes = shell(
      `<template><xmp></template><link rel="stylesheet" href="/unused.css"></xmp></template>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A tree builder closes the head and reprocesses these rather than passing over them, so what
   * comes after one belongs to the body however the markup is laid out.
   */
  it.each(['</body>', '</html>', '</br>'])('stops at %s, which closes a head', (closing) => {
    const bytes = encodeUtf8(
      `<!doctype html><html><head><link rel="stylesheet" href="${STYLE}"/>${closing}` +
        `<link rel="stylesheet" href="/in-the-body.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A tokenizer folds the ASCII and nothing else. `toLowerCase()` folds the whole of Unicode, and
   * a Kelvin sign is what turns an element no browser loads into one this would have promoted.
   */
  it('folds a name the way a tokenizer folds it, and no further', () => {
    // Last, because an element a head cannot hold closes the head whatever its name folds to.
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}"/>` +
        `<lin\u{212A} rel="stylesheet" href="/unused.css">`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A browser decodes the references in `rel` before it splits the value, so a word this cannot
   * read is a word that could be hiding `alternate`.
   */
  it('promotes no link whose relation carries a reference it does not read', () => {
    const bytes = shell(
      `<link rel="stylesheet alternate&#32;" href="/alternate.css"/>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /** A tag name is ASCII case-insensitive, so a head that shouts still ends where it says. */
  it('stops at the end of a head written in capitals', () => {
    const bytes = encodeUtf8(
      `<!doctype html><HTML><HEAD><link rel="stylesheet" href="${STYLE}"/></HEAD>` +
        `<BODY><link rel="stylesheet" href="/in-the-body.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * `toLowerCase()` is not one character for one: `İ` becomes two, which would slide every index
   * the scan takes from the lowercased copy past what it was pointing at in the markup.
   */
  it('keeps its bearings in a head whose text does not lowercase one for one', () => {
    const bytes = shell(`<title>İstanbul İzmir</title><link rel="stylesheet" href="${STYLE}"/>`);

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /** A browser does not fetch what a comment names, and neither does this. */
  it('ignores a link inside a comment, and stops at the end of the head', () => {
    const commented = shell(
      `<!-- <link rel="stylesheet" href="/commented.css"/> --><link rel="stylesheet" href="${STYLE}"/>`,
      `<link rel="stylesheet" href="/in-the-body.css"/>`,
    );

    expect(shellPreloadLinks(commented, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  it('names an href once, whoever named it first', () => {
    const twice = shell(
      `<link rel="stylesheet" href="${STYLE}"/><link rel="stylesheet" href="${STYLE}"/>`,
    );
    const advertised = `<${FONT}>; rel=preload; as="font"; crossorigin=""`;
    const both = shell(
      `<link rel="stylesheet" href="${STYLE}"/>` +
        `<link rel="preload" as="font" href="${FONT}" crossorigin=""/>`,
    );

    expect(shellPreloadLinks(twice, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
    // The origin already asked for the font on its own `Link`; saying it again wastes the header.
    expect(shellPreloadLinks(both, advertised)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * The origin naming a file at all is not the origin preloading it: a canonical link starts no
   * fetch, and leaving the stylesheet out because of one would advertise nothing of the kind.
   */
  it('gives way only to a preload the origin already sent', () => {
    const bytes = shell(`<link rel="stylesheet" href="${STYLE}"/>`);
    const canonical = `<${STYLE}>; rel=canonical`;
    const preloaded = `<${STYLE}>; rel="preload"; as="style"`;

    expect(shellPreloadLinks(bytes, canonical)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
    expect(shellPreloadLinks(bytes, preloaded)).toStrictEqual([]);
  });

  /**
   * A preload the header only sends under a condition is one a device may never fetch, and a
   * preload of another shape is a different request. Neither stands in for the one this would add.
   */
  it.each([
    ['conditional on a medium', `; rel=preload; as=style; media=print`],
    ['for another type', `; rel=preload; as=style; type="text/less"`],
    ['fetched another way', `; rel=preload; as=style; crossorigin=""`],
  ])('keeps its own beside a preload %s', (_case, parameters) => {
    const bytes = shell(`<link rel="stylesheet" href="${STYLE}"/>`);

    expect(shellPreloadLinks(bytes, `<${STYLE}>${parameters}`)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A comment ends where a tokenizer ends it, and `--!>` is one of the ways. Reading past it would
   * step over the `<body>` after it, and a head that never ends reads the body's links as its own.
   */
  it.each(['<!-- --!>', '<!-->'])('ends a comment at %s, as a tokenizer does', (comment) => {
    const bytes = encodeUtf8(
      `<!doctype html><html><head><link rel="stylesheet" href="${STYLE}"/>${comment}` +
        `<body><!-- --><link rel="stylesheet" href="/in-the-body.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * The other way round: `<!---!>` spells a close only by borrowing the dash it opened with, and a
   * tokenizer reads that one as the comment's first character instead. Nothing after it is markup.
   */
  it('leaves a comment open that only its own opener would close', () => {
    const bytes = encodeUtf8(
      `<!doctype html><html><head><link rel="stylesheet" href="${STYLE}"/><!---!>` +
        `<link rel="stylesheet" href="/after-a-comment.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A `</template>` closes nothing when no template is open — a parser ignores it — so the walk
   * holds its count at zero rather than reading one below. The `</svg>` behind it must not take
   * that count again: below zero the walk is never back where the head is, and every link the
   * body names is read as the head's.
   */
  it('leaves a foreign element on a count a stray end tag already took', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="${STYLE}"/><template><svg></template></template></svg>`,
      `<link rel="stylesheet" href="/in-the-body.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * The header was split on the commas outside its quoted strings, so one still inside them is a
   * character of the value: `as="style,"` names no destination a browser has, and a hint that
   * read it as `style` would stand aside for a preload that starts nothing.
   */
  it('reads a quoted parameter with the comma it was written with', () => {
    const bytes = shell(`<link rel="stylesheet" href="${STYLE}"/>`);

    expect(shellPreloadLinks(bytes, `<${STYLE}>; rel=preload; as="style,"`)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * What follows the reference is parameters or nothing. A value carrying anything else is one
   * the grammar does not describe and a parser passes over whole, so nothing in it is advertised
   * — and a hint that read its `rel` would stand down for a preload nobody was told about.
   */
  it('reads no parameters out of a value that carries junk behind its reference', () => {
    const bytes = shell(`<link rel="stylesheet" href="${STYLE}"/>`);

    expect(shellPreloadLinks(bytes, `<${STYLE}>junk; rel=preload; as=style`)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /** A media type is read without case wherever it is written, a header's value included. */
  it('reads a header’s media as the one the markup would be read as', () => {
    const bytes = shell(`<link rel="stylesheet" href="${STYLE}"/>`);

    expect(shellPreloadLinks(bytes, `<${STYLE}>; rel=preload; as=style; media=ALL`)).toStrictEqual(
      [],
    );
  });

  /**
   * An `anchor` is read past rather than read: the algorithm a browser processes a `Link` header
   * by has no step for it, so a value carrying one preloads for this document like any other —
   * and a hint that ignored it would send the file the header already sends.
   */
  it('gives way to a value whose parameters it does not act on', () => {
    const bytes = shell(`<link rel="stylesheet" href="${STYLE}"/>`);
    const anchored = `<${STYLE}>; rel=preload; as=style; anchor="/other"`;

    expect(shellPreloadLinks(bytes, anchored)).toStrictEqual([]);
  });

  /**
   * A link-value opens with its reference. One that does not is a value a parser skips whole, so
   * the file named inside it is advertised to nobody — and a hint that stood down for it would
   * leave the stylesheet to be found by parsing the document.
   */
  it('reads no reference out of a value that does not open with one', () => {
    const bytes = shell(`<link rel="stylesheet" href="${STYLE}"/>`);

    expect(shellPreloadLinks(bytes, `junk<${STYLE}>; rel=preload; as=style`)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A quoted string is read with its escapes resolved: `pre\load` is `preload` to a parser, and
   * the header that writes it that way advertises the preload this would otherwise send again.
   */
  it('reads a quoted parameter with its escapes resolved', () => {
    const bytes = shell(`<link rel="stylesheet" href="${STYLE}"/>`);

    const escaped = String.raw`<${STYLE}>; rel="pre\load"; as="sty\le"`;

    expect(shellPreloadLinks(bytes, escaped)).toStrictEqual([]);
  });

  /**
   * A parameter may be written without a value, and a header usually writes the `crossorigin` of
   * an anonymous preload that way. It is the empty value, which is the anonymous state — so it
   * stands in for a link the markup fetches in that mode, and not for one it fetches in no CORS
   * mode at all, which is a request that preload cannot answer.
   */
  it('reads a parameter written without a value as the empty one', () => {
    const anonymous = shell(`<link rel="stylesheet" href="${STYLE}" crossorigin/>`);
    const plain = shell(`<link rel="stylesheet" href="${STYLE}"/>`);
    const advertised = `<${STYLE}>; rel=preload; as=style; crossorigin`;

    expect(shellPreloadLinks(anonymous, advertised)).toStrictEqual([]);
    expect(shellPreloadLinks(plain, advertised)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A preload names a destination, and the same file preloaded as something else is not the
   * request the page is waiting on: giving way to it would leave the stylesheet unadvertised.
   */
  it('gives way only to a preload of the same destination', () => {
    const bytes = shell(`<link rel="stylesheet" href="${STYLE}"/>`);
    const asScript = `<${STYLE}>; rel=preload; as=script`;
    const asStyle = `<${STYLE}>; rel=preload; as="style"`;

    expect(shellPreloadLinks(bytes, asScript)).toStrictEqual([`<${STYLE}>; rel=preload; as=style`]);
    expect(shellPreloadLinks(bytes, asStyle)).toStrictEqual([]);
  });

  /**
   * Text closes a head the markup did not close itself, so what a stray word is followed by is
   * the body's. A doctype is not text, though, and a document starts with one.
   */
  it('stops at the text an omitted head is closed by', () => {
    const bytes = encodeUtf8(
      `<!doctype html><html><head><link rel="stylesheet" href="${STYLE}"/>` +
        `Hello<link rel="stylesheet" href="/in-the-body.css"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * The scan stops at a fixed number of bytes, so the last tag in the window may be half of one —
   * with the `rel` and `href` read and the attribute that would have excluded it still to come.
   */
  it('promotes nothing from a tag the scan was cut off in the middle of', () => {
    const cut = `<link rel="stylesheet" href="/half.css" me`;
    const bytes = encodeUtf8(
      `<!doctype html><html><head><link rel="stylesheet" href="${STYLE}"/>${cut}`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * A tokenizer resolves every character reference in an attribute. `&amp;` is the one a query
   * string is written with; anything else names a file this would repeat as another one.
   */
  it('promotes no href carrying a reference it does not read', () => {
    const bytes = shell(
      `<link rel="stylesheet" href="/styles&#47app.css"/>` +
        `<link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  it('records no more than a header should carry', () => {
    const many = Array.from(
      { length: MAX_PRELOAD_LINKS + 2 },
      (_unused, index) => `<link rel="stylesheet" href="/chunk-${index}.css"/>`,
    ).join('');

    expect(shellPreloadLinks(shell(many), undefined)).toHaveLength(MAX_PRELOAD_LINKS);
  });

  /**
   * Counted after the header has taken its share, not before. A head whose first few are already
   * advertised still has the rest to name, and capping the scan would have thrown them away
   * before anyone knew the header was going to make room.
   */
  it('counts what survives the header, not what the head named first', () => {
    const many = Array.from(
      { length: MAX_PRELOAD_LINKS + 2 },
      (_unused, index) => `<link rel="stylesheet" href="/chunk-${index}.css"/>`,
    ).join('');
    const advertised = Array.from(
      { length: MAX_PRELOAD_LINKS },
      (_unused, index) => `</chunk-${index}.css>; rel=preload; as=style`,
    ).join(', ');

    expect(shellPreloadLinks(shell(many), advertised)).toStrictEqual([
      `</chunk-${MAX_PRELOAD_LINKS}.css>; rel=preload; as=style`,
      `</chunk-${MAX_PRELOAD_LINKS + 1}.css>; rel=preload; as=style`,
    ]);
  });

  /**
   * However many the header already names, the scan carries on past them: it is counting what it
   * can add, and stopping at a number of links rather than of additions would stop too early.
   */
  it('keeps looking past everything the header already names', () => {
    const count = MAX_PRELOAD_LINKS * 8;
    const many = Array.from(
      { length: count + 1 },
      (_unused, index) => `<link rel="stylesheet" href="/chunk-${index}.css"/>`,
    ).join('');
    const advertised = Array.from(
      { length: count },
      (_unused, index) => `</chunk-${index}.css>; rel=preload; as=style`,
    ).join(', ');

    expect(shellPreloadLinks(shell(many), advertised)).toStrictEqual([
      `</chunk-${count}.css>; rel=preload; as=style`,
    ]);
  });

  it('leaves out a name too long to belong in a header', () => {
    const long = `/${'a'.repeat(300)}.css`;
    const bytes = shell(
      `<link rel="stylesheet" href="${long}"/><link rel="stylesheet" href="${STYLE}"/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
    ]);
  });

  /**
   * An empty `title` names no set, and a preload belongs to none: each is fetched whatever set the
   * document prefers.
   */
  it('promotes a link that no title puts in a set', () => {
    const bytes = shell(
      `<link rel="stylesheet" title="" href="${STYLE}"/>` +
        `<link rel="preload" as="font" title="Body" href="${FONT}" crossorigin/>`,
    );

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}>; rel=preload; as=style`,
      `<${FONT}>; rel=preload; as=font; crossorigin="anonymous"`,
    ]);
  });

  /** An escape, a query and a fragment, each where the grammar puts it, travel as written. */
  it('keeps an href written as RFC 3986 writes one', () => {
    const href = '/_next/static/chunks/%5Broot%5D.css?v=1#main';
    const bytes = shell(`<link rel="stylesheet" href="${href}"/>`);

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([`<${href}>; rel=preload; as=style`]);
  });

  /** The `?dpl=` every Vercel asset is named with: a query is part of the name, not a new value. */
  it('keeps the query a versioned asset is named by', () => {
    const versioned = `${STYLE}?dpl=dpl_9Ab-c&amp;v=2`;
    const bytes = shell(`<link rel="stylesheet" href="${versioned}"/>`);

    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([
      `<${STYLE}?dpl=dpl_9Ab-c&v=2>; rel=preload; as=style`,
    ]);
  });

  it.each([
    ['a head with nothing in it', shell('')],
    ['a document with no head at all', encodeUtf8('<!doctype html><p>hello</p>')],
    ['an element whose name only starts like a link', shell('<linkbait href="/x.css"/>')],
    ['a link with no href', shell('<link rel="stylesheet"/>')],
    // The shell is the origin's to write and a header value is not: a runtime refuses to set one
    // carrying a newline, which would take the route down every time it was served.
    [
      'an href with a character no header can hold',
      shell(`<link rel=stylesheet href="/a.css\nx: y">`),
    ],
    ['an href that would arrive as two values', shell('<link rel=stylesheet href="/a,b.css">')],
    // A browser fetches each of these as written; a header is read by hops that parse the
    // reference, and RFC 3986 gives none of them a meaning there.
    [
      'an href with a percent that escapes nothing',
      shell('<link rel=stylesheet href="/a%zz.css">'),
    ],
    ['an href with a bracket outside a host', shell('<link rel=stylesheet href="/a[1].css">')],
    ['an href with a second fragment', shell('<link rel=stylesheet href="/a.css#x#y">')],
    // A title puts the sheet in a named set, applied only if it is the one the document prefers,
    // which a `default-style` anywhere in the document may change.
    ['a stylesheet of a named set', shell('<link rel="stylesheet" title="Dark" href="/dark.css">')],
    // A font is fetched in CORS mode whatever the page does. Promoting a preload that does not say
    // so would put a download the page's own font request cannot use in front of the paint.
    [
      'a font preload the markup left without crossorigin',
      shell(`<link rel="preload" as="font" href="${FONT}" type="font/woff2">`),
    ],
    // Not a parameter a `Link` is read for, so the hint would fetch under the document's policy
    // and send a `Referer` the markup had suppressed.
    [
      'a link fetched under a referrer policy of its own',
      shell(`<link rel="stylesheet" href="/private.css" referrerpolicy="no-referrer">`),
    ],
    // A header-borne request carries no nonce, so a policy that names only one blocks it — and
    // reports a violation for the trouble, while the markup's own link loads as it always did.
    [
      'a link a policy authorises by the nonce it carries',
      shell(`<link rel="stylesheet" href="/nonced.css" nonce="fixed">`),
    ],
    // The page asked for this one last; a hint at the default would start it against the sheets
    // this exists to start first.
    [
      'a link the markup asks for at a priority of its own',
      shell(`<link rel="stylesheet" href="/later.css" fetchpriority="low">`),
    ],
  ])('promotes nothing from %s', (_case, bytes) => {
    expect(shellPreloadLinks(bytes, undefined)).toStrictEqual([]);
  });
});
