import type { CheckedStack } from './answers.ts';
import { type Asked, routeVerdict } from './documents.ts';
import { requestsForRules } from './rule-witnesses.ts';

/** Exercise configured document headers under query, cookie and header conditions as well. */
export async function documentRuleFailure(
  stack: CheckedStack,
  headBytes: number,
  asked: Asked,
): Promise<string | undefined> {
  const requests = requestsForRules(
    stack,
    new URL(asked.requested, stack.site),
    asked.headers,
    stack.manifest.headerRules ?? [],
  );
  if (typeof requests === 'string') return requests;
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
