import { describe, expect, it } from 'vitest';

import { rendersFormActionsWithResumeData } from '../src/next/index.ts';

/**
 * Which Next.js versions render a form's Server Action whole with the resume data cache the host
 * hands it (vercel/next.js#100740), and are handed the page's postponed state for one.
 */
describe('a form action rendered with the resume data cache', () => {
  it.each([
    '16.5.0-canary.28',
    '16.5.0-canary.30',
    '16.5.0-rc.0',
    '16.5.0',
    '16.5.1',
    '16.6.0-canary.1',
    '17.0.0',
  ])('is rendered so by %s', (version) => {
    expect(rendersFormActionsWithResumeData(version)).toBe(true);
  });

  it.each(['16.4.3', '16.5.0-canary.27', '16.5.0-canary.0', '16.4.0-canary.50', '16.2.6'])(
    'is not by %s, which answers with what follows the shell',
    (version) => {
      expect(rendersFormActionsWithResumeData(version)).toBe(false);
    },
  );

  /** One that cannot be read is given what renders whole without it. */
  it.each(['', 'latest', '16.5', '16.5.0nonsense'])('is not by the unreadable %j', (version) => {
    expect(rendersFormActionsWithResumeData(version)).toBe(false);
  });
});
