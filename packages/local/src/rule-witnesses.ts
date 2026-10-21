import { headerRulesFor, type HeaderRule } from '@stayingupwind/core/manifest';

import type { CheckedStack } from './answers.ts';
import { carryingEach, lackingEach, protocolCondition } from './escaping.ts';
import { routedReads } from './routing-reads.ts';
import { ruleOverlapFailure } from './rule-overlaps.ts';

export interface RuleRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: URL;
  readonly what: string;
}

export interface RuleRequests {
  readonly requests: readonly RuleRequest[];
  readonly unproved?: string;
}

/** Rules of this pathname whose fixed protocol conditions permit this class of request. */
function applies(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  rule: HeaderRule,
): boolean {
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
  const read = routedReads(url, sent);
  const pathOnly = {
    ...stack.manifest,
    headerRules: [{ sourceRegex: rule.sourceRegex, headers: rule.headers }],
  };
  return (
    headerRulesFor(fixed, url, read).conditioned &&
    Object.keys(headerRulesFor(pathOnly, url, read).headers).length > 0
  );
}

/** Requests selecting each applicable conditioned rule; an unwitnessed rule proves nothing. */
export function requestsForRules(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  rules: readonly HeaderRule[],
): RuleRequests {
  const requests: RuleRequest[] = [];
  // Include rules already selected by an ordinary sample: they can conceal a new witness's
  // other branch too. No independent regex-language prover is implied by one matching request.
  const unproved = ruleOverlapFailure(
    (stack.manifest.headerRules ?? []).filter((rule) => applies(stack, url, sent, rule)),
  );
  if (unproved !== undefined) return { requests, unproved };
  for (const rule of rules) {
    if (rule.has === undefined && rule.missing === undefined) continue;
    const alone = { ...stack.manifest, headerRules: [rule] };
    const selected = (headers: Readonly<Record<string, string>>, at: URL): boolean =>
      headerRulesFor(alone, at, routedReads(at, headers)).conditioned;
    if (selected(sent, url)) continue;
    // A fixed host/front-line header, or a payload-only protocol field, cannot be changed to
    // select this rule while keeping a request of this class. Other query/cookie/header values can.
    if (!applies(stack, url, sent, rule)) continue;
    // Fixed conditions already hold for this request class. Only movable fields need changing;
    // asking lackingEach to remove a protocol field would reject even one already absent.
    const movableHas = (rule.has ?? []).filter((condition) => !protocolCondition(condition));
    const movableMissing = (rule.missing ?? []).filter(
      (condition) => !protocolCondition(condition),
    );
    const carried = carryingEach(sent, url, movableHas);
    const made = carried === undefined ? undefined : lackingEach(carried, movableMissing);
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
