import { describe, expect, it } from 'vitest';

import { describeIssues } from '../../cache/src/gateway/respond.ts';
import * as z from '../../core/src/schema/index.ts';
import { safeParseBounded } from '../src/util/parse.ts';

describe('bounded boundary diagnostics', () => {
  it('collects one error from many small malformed values', () => {
    const schema = z.object({ outputs: z.array(z.object({ a: z.string(), b: z.string() })) });
    const value = { outputs: Array.from({ length: 1000 }, () => ({})) };
    const parsed = safeParseBounded(schema, value, JSON.stringify(value).length);
    expect(parsed.success).toBe(false);
    if (parsed.success || parsed.error === undefined) throw new Error('missing diagnostic');
    expect(parsed.error.issues).toHaveLength(1);
    expect(describeIssues(parsed.error).length).toBeLessThan(256);
  });

  it('caps issue count, long paths, and long messages before combining them', () => {
    const many = {
      issues: Array.from({ length: 1000 }, () => ({ code: 'custom', path: [], message: 'bad' })),
    };
    expect(describeIssues(many).split('; ')).toHaveLength(32);
    const huge = {
      issues: [{ code: 'custom', path: ['x'.repeat(20_000)], message: 'y'.repeat(20_000) }],
    };
    expect(describeIssues(huge)).toHaveLength(8192);
  });
});
