import { NEXT_HTML_LIMITED_BOTS } from '@stayingupwind/core/request';
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

  it('sends blocking metadata when a custom pattern sees a user-agent longer than 512 characters', () => {
    const within = asked(`${'x'.repeat(500)}MyBot`);
    const browserWithin = asked(`${'x'.repeat(490)}Chrome/129`);
    const botPast = asked(`${'x'.repeat(512)}MyBot`);
    const browserPast = asked(`${'x'.repeat(512)}Chrome/129`);
    const defaultBotPast = asked(`${'x'.repeat(600)}Twitterbot/1.0`);
    const defaultBrowserPast = asked(`${'x'.repeat(600)}Chrome/129`);

    expect(wantsBlockingMetadata(within, 'MyBot')).toBe(true);
    expect(wantsBlockingMetadata(browserWithin, 'MyBot')).toBe(false);
    expect(wantsBlockingMetadata(botPast, 'MyBot')).toBe(true);
    expect(wantsBlockingMetadata(browserPast, 'MyBot')).toBe(true);
    expect(wantsBlockingMetadata(defaultBotPast, undefined)).toBe(true);
    expect(wantsBlockingMetadata(defaultBrowserPast, NEXT_HTML_LIMITED_BOTS)).toBe(false);
  });

  it('bounds polynomial and catastrophic patterns passed directly to wantsBlockingMetadata', () => {
    const longRun = asked('a'.repeat(200));
    const shortMiss = asked('Browser');

    expect(wantsBlockingMetadata(longRun, '^a+a+a+a+a+b$')).toBe(true);
    expect(wantsBlockingMetadata(shortMiss, '^a+a+a+a+a+b$')).toBe(false);
    expect(wantsBlockingMetadata(longRun, '(a+)+')).toBe(true);
    expect(wantsBlockingMetadata(shortMiss, '(a+)+')).toBe(true);
  });
});
