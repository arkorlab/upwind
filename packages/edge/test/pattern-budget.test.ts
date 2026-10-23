import { headerRulesFor } from '@stayingupwind/core/manifest';
import { PatternBudgetExceededError } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

import { withPatternBudget } from '../src/pattern-budget.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

/** Next.js's compilation of `/:x(a+a+)!`: one test fits, two together do not. */
const QUADRATIC = String.raw`^(?:\/(a+a+))\![\/#\?]?$`;
const PATH = `/${'a'.repeat(700)}`;

async function routingTest() {
  const { manifest } = await seedSite({
    document: pprDocument(),
    headerRules: [{ sourceRegex: QUADRATIC, headers: { 'x-test': 'never matches' } }],
  });
  const url = new URL(`https://site.example${PATH}`);
  return () => headerRulesFor(manifest, url, new Headers());
}

describe('a request’s total routing allowance', () => {
  it('keeps the same allowance when routing is entered again', async () => {
    const test = await routingTest();

    withPatternBudget(() => {
      expect(test).not.toThrow();
      expect(() => withPatternBudget(test)).toThrow(PatternBudgetExceededError);
    });

    expect(() => withPatternBudget(test)).not.toThrow();
  });

  it('keeps concurrent requests separate across asynchronous waits', async () => {
    const test = await routingTest();
    const waiting = Promise.withResolvers<undefined>();
    const first = withPatternBudget(async () => {
      expect(test).not.toThrow();

      await waiting.promise;

      expect(test).toThrow(PatternBudgetExceededError);
    });
    const second = withPatternBudget(async () => {
      expect(test).not.toThrow();

      await Promise.resolve();

      expect(test).toThrow(PatternBudgetExceededError);

      waiting.resolve(undefined);
    });

    await Promise.all([first, second]);
  });
});
