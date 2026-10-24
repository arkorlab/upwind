import { describe, expect, it } from 'vitest';

import { acceptsHtml, negotiateContentEncoding } from '../src/request/accept.ts';

describe('acceptsHtml', () => {
  it('treats a missing header as no preference', () => {
    expect(acceptsHtml(null)).toBe(true);
  });

  it('accepts browser navigation headers', () => {
    expect(acceptsHtml('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(
      true,
    );
    expect(acceptsHtml('*/*')).toBe(true);
    expect(acceptsHtml('text/*')).toBe(true);
  });

  it('refuses HTML that the request scored zero', () => {
    // The origin would negotiate something else or answer 406; replaying a shell changes that.
    expect(acceptsHtml('application/json, text/html;q=0')).toBe(false);
    expect(acceptsHtml('application/json, */*;q=0')).toBe(false);
    // The specific type overrides the wildcard, so the wildcard's quality does not rescue it.
    expect(acceptsHtml('text/html;q=0, */*;q=0.1')).toBe(false);
  });

  it('lets the most specific range decide', () => {
    expect(acceptsHtml('*/*;q=0.5, text/html;q=0')).toBe(false);
    expect(acceptsHtml('text/*;q=0, text/html;q=1')).toBe(true);
  });

  it('refuses a header that never mentions HTML', () => {
    expect(acceptsHtml('application/json')).toBe(false);
    expect(acceptsHtml('')).toBe(false);
  });
});

describe('acceptsHtml with a repeated range', () => {
  /** Taking the last offer would let a header read as a refusal on nothing but the order. */
  it('keeps the best quality a range was offered at', () => {
    expect(acceptsHtml('text/html, text/html;q=0')).toBe(true);
    expect(acceptsHtml('text/html;q=0, text/html')).toBe(true);
  });

  it('still refuses a range offered only at zero', () => {
    expect(acceptsHtml('text/html;q=0')).toBe(false);
    expect(acceptsHtml('text/html;q=0, */*;q=0')).toBe(false);
  });
});

describe('negotiateContentEncoding', () => {
  const both = new Set(['br', 'gzip'] as const);

  it('prefers brotli when the client accepts both', () => {
    expect(negotiateContentEncoding('gzip, deflate, br', both)).toBe('br');
    expect(negotiateContentEncoding('gzip, deflate, br, zstd', both)).toBe('br');
    expect(negotiateContentEncoding('BR', both)).toBe('br');
  });

  it('falls back to gzip when brotli is not accepted or not offered', () => {
    expect(negotiateContentEncoding('gzip, deflate', both)).toBe('gzip');
    expect(negotiateContentEncoding('gzip, br', new Set(['gzip'] as const))).toBe('gzip');
  });

  it('serves identity without a header, without an offer, or when everything offered scores zero', () => {
    expect(negotiateContentEncoding(null, both)).toBe('identity');
    expect(negotiateContentEncoding('', both)).toBe('identity');
    expect(negotiateContentEncoding('br', new Set())).toBe('identity');
    expect(negotiateContentEncoding('br;q=0, gzip;q=0', both)).toBe('identity');
    expect(negotiateContentEncoding('identity', both)).toBe('identity');
  });

  it('lets quality values and the wildcard decide', () => {
    expect(negotiateContentEncoding('br;q=0.5, gzip;q=0.9', both)).toBe('gzip');
    expect(negotiateContentEncoding('*', both)).toBe('br');
    expect(negotiateContentEncoding('gzip, *;q=0', both)).toBe('gzip');
    expect(negotiateContentEncoding('br;q=0, *', both)).toBe('gzip');
    // A coding listed twice keeps its best offer.
    expect(negotiateContentEncoding('br;q=0, br', both)).toBe('br');
  });

  it('respects a client that rates identity above a rendering', () => {
    expect(negotiateContentEncoding('br;q=0.1, identity;q=1', both)).toBe('identity');
    // `*` covers identity too, so here it outranks both renderings.
    expect(negotiateContentEncoding('br;q=0.1, gzip;q=0.2, *;q=0.5', both)).toBe('identity');
    // Rated equal, the rendering wins: it is the same document in fewer bytes.
    expect(negotiateContentEncoding('br, identity', both)).toBe('br');
    expect(negotiateContentEncoding('gzip;q=0.8, identity;q=0.5, br;q=0.4', both)).toBe('gzip');
    // A client that never mentions identity has stated no preference for it.
    expect(negotiateContentEncoding('br;q=0.1', both)).toBe('br');
  });
});
