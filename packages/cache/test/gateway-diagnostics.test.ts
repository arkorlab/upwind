import * as z from '@stayingupwind/core/schema';
import { type BoundedParse, type ParseFailure, safeParseBounded } from '@stayingupwind/host/util';
import { describe, expect, it } from 'vitest';

import { describeIssues } from '../src/gateway/respond.ts';

function diagnosticOf<T>(parsed: BoundedParse<T>): ParseFailure {
  if (parsed.success || parsed.error === undefined) throw new Error('missing diagnostic');
  return parsed.error;
}

describe('bounded boundary diagnostics', () => {
  it('collects one error from many small malformed values', () => {
    const output = z.object({ a: z.string(), b: z.string() });
    const schema = z.object({ outputs: z.array(output) });
    const value = { outputs: Array.from({ length: 1000 }, () => ({})) };
    const parsed = safeParseBounded(schema, value, JSON.stringify(value).length);

    expect(parsed.success).toBe(false);

    const diagnostic = diagnosticOf(parsed);

    expect(diagnostic.issues).toHaveLength(1);
    expect(describeIssues(diagnostic).length).toBeLessThan(256);
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
