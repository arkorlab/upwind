import { describe, expect, it } from 'vitest';

import { wantsBlockingMetadata } from '../src/incoming.ts';

/**
 * Who Next.js sends blocking metadata to, and so renders a partially prerendered page whole for:
 * a user agent `htmlLimitedBots` names, tested case-insensitively anywhere in the value
 * (`shouldServeStreamingMetadata`), or one on Next.js's own list when the build recorded none.
 */

function asked(userAgent: string | undefined): Request {
  return new Request('https://app.test/', {
    headers: userAgent === undefined ? {} : { 'user-agent': userAgent },
  });
}

describe('a visitor Next.js sends blocking metadata to', () => {
  it('is one the configured pattern names, anywhere in the value and in any case', () => {
    expect(wantsBlockingMetadata(asked('MyBot'), 'MyBot|Discordbot')).toBe(true);
    expect(wantsBlockingMetadata(asked('Mozilla/5.0 (compatible; mybot/2.1)'), 'MyBot')).toBe(true);
    expect(wantsBlockingMetadata(asked('Mozilla/5.0 Chrome/129'), 'MyBot')).toBe(false);
  });

  it('is anyone at all under a pattern that names every agent', () => {
    expect(wantsBlockingMetadata(asked('MyBrowser'), '.*')).toBe(true);
  });

  it('is one on Next.js’s own list when the build recorded no pattern', () => {
    expect(
      wantsBlockingMetadata(asked('Mozilla/5.0 (compatible; Twitterbot/1.0)'), undefined),
    ).toBe(true);
    expect(wantsBlockingMetadata(asked('Mozilla/5.0 Chrome/129'), undefined)).toBe(false);
  });

  /** Next.js reads an empty pattern as none, and tests its own list (`htmlLimitedBots || …`). */
  it('is one on Next.js’s own list under an empty pattern, not every agent', () => {
    expect(wantsBlockingMetadata(asked('Twitterbot/1.0'), '')).toBe(true);
    expect(wantsBlockingMetadata(asked('Mozilla/5.0 Chrome/129'), '')).toBe(false);
  });

  it('is never a request that names no agent, nor under a pattern that does not compile', () => {
    expect(wantsBlockingMetadata(asked(undefined), '.*')).toBe(false);
    expect(wantsBlockingMetadata(asked('MyBot'), '(')).toBe(false);
  });
});
