import { describe, expect, it } from 'vitest';

import type { KeptMiddlewareResult } from '../src/answers.ts';
import { rewriteStatusVerdict } from '../src/part-handoffs.ts';

function continued(rewriteStatus: number | undefined): KeptMiddlewareResult {
  return {
    kind: 'continue',
    url: new URL('https://site.example/about'),
    rewritten: false,
    requestHeaders: new Headers(),
    responseHeaders: new Headers(),
    setCookie: undefined,
    rewriteStatus,
  };
}

describe('a document or part handed on for a captured middleware rewrite status', () => {
  it.each([404, 418])(
    'accepts a captured %s rewrite even when the URL stays the same',
    (status) => {
      const decided = continued(status);

      expect(rewriteStatusVerdict(decided, true)).toStrictEqual({
        kind: 'skipped',
        reason: "the application's middleware gave its rewrite a status",
      });
    },
  );

  it('rejects the diagnostic reason when no rewrite status was captured', () => {
    const decided = continued(undefined);

    expect(rewriteStatusVerdict(decided, true).kind).toBe('failed');
  });

  it('rejects the diagnostic reason when no middleware answer was kept', () => {
    expect(rewriteStatusVerdict(undefined, true).kind).toBe('failed');
  });

  it('rejects a captured rewrite when the build has no applicable middleware', () => {
    const decided = continued(404);

    expect(rewriteStatusVerdict(decided, false).kind).toBe('failed');
  });
});
