import { headerRulesFor, type HeaderRule } from '@stayingupwind/core/manifest';

import type { CheckedStack } from './answers.ts';
import { carryingEach, lackingEach, protocolCondition } from './escaping.ts';
import { routedReads } from './routing-reads.ts';

export interface RuleRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: URL;
  readonly what: string;
}

export interface RuleRequests {
  readonly requests: readonly RuleRequest[];
  readonly unproved?: string;
}

/** Requests selecting each applicable conditioned rule; an unwitnessed rule proves nothing. */
export function requestsForRules(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  rules: readonly HeaderRule[],
): RuleRequests {
  const requests: RuleRequest[] = [];
  for (const rule of rules) {
    if (rule.has === undefined && rule.missing === undefined) continue;
    const alone = { ...stack.manifest, headerRules: [rule] };
    const selected = (headers: Readonly<Record<string, string>>, at: URL): boolean =>
      headerRulesFor(alone, at, routedReads(at, headers)).conditioned;
    if (selected(sent, url)) continue;
    // A fixed host/front-line header, or a payload-only protocol field, cannot be changed to
    // select this rule while keeping a request of this class. Other query/cookie/header values can.
    const fixed = {
      ...stack.manifest,
      headerRules: [
        {
          ...rule,
          has: (rule.has ?? []).filter(protocolCondition),
          missing: (rule.missing ?? []).filter(protocolCondition),
        },
      ],
    };
    if (!headerRulesFor(fixed, url, routedReads(url, sent)).conditioned) continue;
    // A condition for another pathname is not a missing witness for this file or page.
    const pathOnly = {
      ...stack.manifest,
      headerRules: [{ sourceRegex: rule.sourceRegex, headers: rule.headers }],
    };
    if (Object.keys(headerRulesFor(pathOnly, url, routedReads(url, sent)).headers).length === 0) {
      continue;
    }
    const carried = carryingEach(sent, url, rule.has ?? []);
    const made = carried === undefined ? undefined : lackingEach(carried, rule.missing ?? []);
    if (carried === undefined || made === undefined || !selected(made.headers, made.url)) {
      return {
        requests,
        unproved:
          'a conditioned header rule applies to this path, but the check finds no request selecting it: no request proves it',
      };
    }
    requests.push({
      headers: made.headers,
      url: made.url,
      what:
        [carried.carried, made.lacked].filter((part) => part !== '').join(', ') ||
        'as it was asked',
    });
  }
  return { requests };
}
