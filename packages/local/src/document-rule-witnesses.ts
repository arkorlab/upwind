import { headerRulesFor } from '@stayingupwind/core/manifest';

import { answeredBy, type CheckedStack } from './answers.ts';
import { type CookieChanges, cookieChangesOf, NO_COOKIE_CHANGES } from './cookie-jar.ts';
import { type Asked, routeVerdict } from './documents.ts';
import { servedOtherThan } from './landings.ts';
import { routedReads } from './routing-reads.ts';
import { requestsForRules } from './rule-witnesses.ts';

interface FollowedRule extends Asked {
  readonly cookieChanges: CookieChanges;
  readonly served: string | undefined;
}

interface RuleChecks {
  readonly sampled: readonly Readonly<Record<string, string>>[];
  readonly followUp: (asked: FollowedRule) => Promise<string | undefined>;
}

/** Exercise configured document headers under query, cookie and header conditions as well. */
export async function documentRuleFailure(
  stack: CheckedStack,
  headBytes: number,
  asked: Asked,
  checks: RuleChecks,
): Promise<string | undefined> {
  const url = new URL(asked.requested, stack.site);
  const rules = (stack.manifest.headerRules ?? []).filter((rule) => {
    const alone = { ...stack.manifest, headerRules: [rule] };
    return checks.sampled.every(
      (headers) => !headerRulesFor(alone, url, routedReads(url, headers)).conditioned,
    );
  });
  const { requests, unproved } = requestsForRules(stack, url, asked.headers, rules);
  if (unproved !== undefined) return unproved;
  for (const request of requests) {
    const witness = {
      ...asked,
      requested: `${request.url.pathname}${request.url.search}`,
      headers: request.headers,
    };
    let cookieChanges: CookieChanges = NO_COOKIE_CHANGES;
    let served: string | undefined;
    const verdict = await routeVerdict(stack, headBytes, {
      ...witness,
      answered: (answer) => {
        cookieChanges = cookieChangesOf(answer.headers);
        served = servedOtherThan(stack.manifest, answeredBy(answer), asked.key);
      },
    });
    if (verdict.kind === 'failed') {
      return `asked for under the header rule (${request.what}), ${verdict.reason}`;
    }
    const failure = await checks.followUp({ ...witness, cookieChanges, served });
    if (failure !== undefined) {
      return `asked for under the header rule (${request.what}), ${failure}`;
    }
  }
  return undefined;
}
