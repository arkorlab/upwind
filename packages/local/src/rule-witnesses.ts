import { headerRulesFor, type HeaderRule } from '@stayingupwind/core/manifest';
import { classifyStaticFile } from '@stayingupwind/core/request';

import type { CheckedStack } from './answers.ts';
import { carryingEach, fixedAsRouted, lackingEach, type WitnessClass } from './escaping.ts';
import { routedReads } from './routing-reads.ts';
import { ruleOverlapFailure } from './rule-overlaps.ts';

interface RuleRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: URL;
  readonly what: string;
  /** The rule the request selects. */
  readonly rule: HeaderRule;
}

export interface RuleRequests {
  readonly requests: readonly RuleRequest[];
  readonly unproved?: string;
}

/**
 * Rules of this pathname whose fixed conditions — protocol ones, and ones over a header forwarding
 * takes off (`fixedAsRouted`) — permit this class of request.
 */
function applies(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  input: { readonly rule: HeaderRule; readonly requestClass: WitnessClass },
): boolean {
  const { rule, requestClass } = input;
  const fixed = {
    ...stack.manifest,
    headerRules: [
      {
        ...rule,
        has: (rule.has ?? []).filter((condition) => fixedAsRouted(condition, requestClass)),
        missing: (rule.missing ?? []).filter((condition) => fixedAsRouted(condition, requestClass)),
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
  const classified = classifyStaticFile({
    method: 'GET',
    url,
    manifest: stack.manifest,
    deployment: stack.manifest.deployment,
  });
  const requestClass = classified?.kind === 'static-file' ? 'file' : 'document';
  // Include rules already selected by an ordinary sample: they can conceal a new witness's
  // other branch too. No independent regex-language prover is implied by one matching request.
  // Each read as a request of this class selects it, whose witnesses vary what it can carry.
  const unproved = ruleOverlapFailure(
    (stack.manifest.headerRules ?? []).filter((rule) =>
      applies(stack, url, sent, { rule, requestClass }),
    ),
    requestClass,
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
    if (!applies(stack, url, sent, { rule, requestClass })) continue;
    // Fixed conditions already hold for this request class. Only movable fields need changing;
    // asking lackingEach to remove a protocol field would reject even one already absent.
    const movableHas = (rule.has ?? []).filter(
      (condition) => !fixedAsRouted(condition, requestClass),
    );
    const movableMissing = (rule.missing ?? []).filter(
      (condition) => !fixedAsRouted(condition, requestClass),
    );
    const carried = carryingEach(sent, url, movableHas, requestClass);
    const made =
      carried === undefined ? undefined : lackingEach(carried, movableMissing, requestClass);
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
      rule,
    });
  }
  return { requests };
}
