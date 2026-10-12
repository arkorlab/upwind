import { describe, expect, it } from 'vitest';

import { hitsOfFile, selfCheck, textOf } from '../src/scan.ts';
import type { Term } from '../src/terms.ts';

/** What a file says, each term by its id and as the file wrote it. */
function saidIn(text: string): { readonly id: string; readonly text: string }[] {
  return hitsOfFile('file.ts', text).map((hit) => ({ id: hit.term.id, text: hit.text }));
}

describe('the terms', () => {
  it('each find what they say they find, and pass over what they say they pass over', () => {
    expect(selfCheck()).toStrictEqual([]);
  });

  it('are refused where one misses its own example, or takes one it should not', () => {
    const broken: Term = {
      id: 'broken',
      pattern: /example/giu,
      why: 'a term that finds the wrong words',
      finds: ['nothing here'],
      passes: ['an example'],
    };

    expect(selfCheck([broken])).toStrictEqual([
      'broken: does not find "nothing here"',
      'broken: finds "an example"',
    ]);
  });

  it('are refused where one is not global, which counts nothing', () => {
    const once: Term = {
      id: 'once',
      pattern: /example/iu,
      why: 'a term that cannot count',
      finds: ['an example'],
      passes: [],
    };

    expect(selfCheck([once])).toStrictEqual(['once: the pattern must be global']);
  });
});

describe('a file', () => {
  it('says a term where it is written, by line and column', () => {
    const [hit] = hitsOfFile('src/a.ts', 'const a = 1;\n// the control plane\n');

    expect(hit).toMatchObject({ file: 'src/a.ts', line: 2, column: 8, text: 'control plane' });
  });

  it('says its terms in the order it writes them, whatever order the terms are listed in', () => {
    expect(saidIn('// billing\n// the dashboard\n// a tenant').map(({ id }) => id)).toStrictEqual([
      'billing',
      'dashboard',
      'tenancy',
    ]);
    expect(saidIn('// a tenant\n// the dashboard\n// billing').map(({ id }) => id)).toStrictEqual([
      'tenancy',
      'dashboard',
      'billing',
    ]);
  });

  it('says a term across a wrapped comment, but not across a paragraph', () => {
    expect(saidIn('/**\n * what the control\n * plane does\n */')).toStrictEqual([
      { id: 'control-plane', text: 'control plane' },
    ]);
    expect(saidIn('the control\n\nplane')).toStrictEqual([]);
  });

  it('says a term an identifier is made of, as the identifier is written', () => {
    expect(saidIn('const isControlPlane = true;')).toStrictEqual([
      { id: 'control-plane', text: 'ControlPlane' },
    ]);
  });

  it('says nothing of the copyright holder, as a licence names it', () => {
    expect(saidIn('Copyright (c) 2026 Arkor and Contributors')).toStrictEqual([]);
    expect(saidIn('Copyright 2026 Arkor and Contributors')).toStrictEqual([]);
    expect(saidIn('served by Arkor and Contributors')).toStrictEqual([
      { id: 'host-name', text: 'Arkor' },
    ]);
  });

  it('says nothing of the identifiers upwind ships', () => {
    expect(
      saidIn("headers.set('x-arkor-edge', ARKOR_CACHE); const kind = 'ppr-shell';"),
    ).toStrictEqual([]);
    expect(saidIn("const kind = 'edge-ppr-shell';")).toStrictEqual([
      { id: 'resource-name', text: 'ppr-' },
    ]);
  });

  it('reads no term across an identifier upwind ships, which stands between words as itself', () => {
    expect(
      saidIn('control x-arkor-edge plane; this ARKOR_CACHE platform; analytics arkor:edge engine'),
    ).toStrictEqual([]);
    expect(hitsOfFile('a.ts', "'x-arkor-edge', the dashboard")).toMatchObject([
      { line: 1, column: 21, text: 'dashboard' },
    ]);
  });
});

describe("a file's bytes", () => {
  const encoder = new TextEncoder();

  it('are read as UTF-8 text', () => {
    expect(textOf('a.ts', encoder.encode('dashboard'))).toBe('dashboard');
  });

  it('are left unread where a NUL says the file is a binary of a binary kind', () => {
    expect(textOf('a.png', Uint8Array.of(0x89, 0x50, 0x00))).toBeUndefined();
  });

  it('are refused where a NUL says the file is not UTF-8 text, whatever its name', () => {
    expect(() => textOf('a.ts', Uint8Array.of(0x61, 0x00))).toThrow(
      'a.ts holds a NUL byte: save it as UTF-8, or name a binary by its kind',
    );
  });

  it('are refused where a byte is not UTF-8, which could split a word unseen', () => {
    // `dash` `0xff` `board`: decoded leniently, a replacement character between two halves.
    const split = Uint8Array.of(...encoder.encode('dash'), 0xff, ...encoder.encode('board'));

    expect(() => textOf('a.ts', split)).toThrow(
      'a.ts is not UTF-8: save it as UTF-8, or name a binary by its kind',
    );
    expect(textOf('a.webp', split)).toBeUndefined();
  });
});
