import { headerRulesFor } from '@stayingupwind/core/manifest';

import type { CheckedStack } from './answers.ts';
import { type Asked, routeVerdict } from './documents.ts';
import { routedReads } from './routing-reads.ts';
import { requestsForRules } from './rule-witnesses.ts';

/** Exercise configured document headers under query, cookie and header conditions as well. */
export async function documentRuleFailure(
  stack: CheckedStack,
  headBytes: number,
  asked: Asked,
  sampled: readonly Readonly<Record<string, string>>[],
): Promise<string | undefined> {
  const url = new URL(asked.requested, stack.site);
  const rules = (stack.manifest.headerRules ?? []).filter((rule) => {
    const alone = { ...stack.manifest, headerRules: [rule] };
    return sampled.every(
      (headers) => !headerRulesFor(alone, url, routedReads(url, headers)).conditioned,
    );
  });
  const { requests, unproved } = requestsForRules(stack, url, asked.headers, rules);
  if (unproved !== undefined) return unproved;
  for (const request of requests) {
    const verdict = await routeVerdict(stack, headBytes, {
      ...asked,
      requested: `${request.url.pathname}${request.url.search}`,
      headers: request.headers,
    });
    if (verdict.kind === 'failed') {
      return `asked for under the header rule (${request.what}), ${verdict.reason}`;
    }
  }
  return undefined;
}
